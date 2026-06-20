// ── otelite client — per-msg_id token 燃費 ──────────────────────
//
// データ源: otelite (Grafana Alloy ベースの自作ダッシュボード, default :3001)。
// 外部ツール前提なので改造せず、既存 API の消費のみで実現する (issue #23)。
//
// JOIN 方式 (実機 :3001 で確認済み, 2026-06-13):
//   - ADR-005 の bridge OTLP span は trace_id = agent-hub message UUID の「-」除去版。
//     例: msg_id 005fda96-6ce5-4493-bbde-a8507a361a01
//         ↔ trace_id 005fda966ce54493bbdea8507a361a01
//   - GET /api/traces/<trace_id> が span 詳細を返し、attributes に
//     message.id / gen_ai.usage.input_tokens / output_tokens /
//     cache_read.input_tokens / gen_ai.request.model が乗っている。
//   - /api/genai/usage は総計のみ (per-msg 不可)。/api/traces (一覧) は token を含まず
//     default 100 件しか返さない。よって per-msg は trace 詳細 API を直引きする。
//
// この方式なら全 trace を走査せず、ツリーに出ている msg_id だけを直接引ける
// (任意の過去メッセージにも効く)。
import { OTELITE_URL, OTELITE_TIMEOUT_MS, OTELITE_CONCURRENCY, OTELITE_CACHE_TTL_MS } from './constants.js';

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  model: string | null;
}

// msg_id (dashed UUID) → trace_id (dashless)
export function msgIdToTraceId(msgId: string): string {
  return msgId.replace(/-/g, '');
}

// ── in-process TTL cache ───────────────────────────────────────
// 燃費は確定済み msg については不変なので短時間キャッシュで再 fetch を抑える。
// value=null も "telemetry なし" としてキャッシュ (TTL で in-flight msg は回収される)。
interface CacheEntry { usage: TokenUsage | null; expires: number; }
const cache = new Map<string, CacheEntry>();

// ── circuit breaker ────────────────────────────────────────────
// otelite 到達不能時に msg ごとの timeout でページが固まるのを防ぐ。
// 接続失敗を観測したら一定時間 fetch を即 null で握りつぶす。
const BREAKER_COOLDOWN_MS = 30_000;
let breakerOpenUntil = 0;

function now(): number { return Date.now(); }

// span attribute の値を整数化する。
// otelite の実値は number (OTLP intValue 等) と string (flat dict / JSON 文字列)
// の双方があり得るため両対応する (reviewer Minor 2)。
// 数値化できなければ NaN を返し、呼び出し側はこれを「該当 attribute なし」として
// found 判定 (= ⛽ N/A) から除外する。float は v1 `_int` に倣い切り捨てる。
export function parseIntAttr(v: unknown): number {
  if (v == null) return NaN;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : NaN;
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? NaN : n;
  }
  return NaN;
}

// otelite span の attributes を flat record に正規化する。
// v1 `_extract_span_usage` (agent-hub/packages/dashboard/server.py:3922) の
// 受理形状を忠実移植:
//   1. flat dict:      { 'gen_ai.usage.input_tokens': 100, ... }
//   2. JSON 文字列:     '{"gen_ai.usage.input_tokens": 100, ...}'
//   3. OTLP key-value: [{ key, value: { intValue|doubleValue|stringValue } }, ...]
// 解析不能・非対応形は {} を返す (v1 と同じく silent skip)。
export function normalizeAttributes(raw: unknown): Record<string, unknown> {
  // (2) JSON 文字列 → parse
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  // (3) OTLP key-value list → flat dict
  // NOTE: v1 に倣い value wrapper は intValue → doubleValue → stringValue の
  //       優先順で取り出す (`in` チェックで 0 を falsy 誤判定しない)。
  if (Array.isArray(raw)) {
    const attrs: Record<string, unknown> = {};
    for (const item of raw) {
      if (item == null || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const key = typeof rec.key === 'string' ? rec.key : '';
      const valWrap = (rec.value ?? {}) as Record<string, unknown>;
      let val: unknown = 0;
      if ('intValue' in valWrap) val = valWrap.intValue;
      else if ('doubleValue' in valWrap) val = valWrap.doubleValue;
      else if ('stringValue' in valWrap) val = valWrap.stringValue;
      attrs[key] = val;
    }
    return attrs;
  }
  // (1) flat dict
  if (raw != null && typeof raw === 'object') {
    return raw as Record<string, unknown>;
  }
  return {};
}

// otelite trace 詳細レスポンスから span 配列を取り出す。
// v1 `_fetch_trace` (server.py:3989) の忠実移植:
//   - bare array       → そのまま span 配列
//   - { spans: [...] } → spans
//   - その他 dict       → [data] (dict 自体を単一 span とみなす)
export function extractSpans(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data != null && typeof data === 'object') {
    const spans = (data as Record<string, unknown>).spans;
    if (Array.isArray(spans)) return spans;
    return [data];
  }
  return [];
}

// trace 詳細レスポンス全体から 1 msg の token 燃費を集計する純粋関数。
// 受理形状 (top-level / attributes) は extractSpans / normalizeAttributes 経由で
// v1 と同等。token attribute がどの span にも無ければ null (= ⛽ N/A)。
export function extractUsageFromTrace(data: unknown, traceId: string): TokenUsage | null {
  const spans = extractSpans(data);
  let input = 0, output = 0, cacheRead = 0;
  let model: string | null = null;
  let found = false;
  for (const s of spans) {
    const rawAttrs = s != null && typeof s === 'object'
      ? (s as Record<string, unknown>).attributes
      : undefined;
    const a = normalizeAttributes(rawAttrs);
    // 念のため message.id が一致する span のみ集計 (通常 1 span)
    const mid = a['message.id'];
    if (typeof mid === 'string' && mid && msgIdToTraceId(mid) !== traceId) continue;
    const i = parseIntAttr(a['gen_ai.usage.input_tokens']);
    const o = parseIntAttr(a['gen_ai.usage.output_tokens']);
    const c = parseIntAttr(a['gen_ai.usage.cache_read.input_tokens']);
    if (!Number.isNaN(i)) { input += i; found = true; }
    if (!Number.isNaN(o)) { output += o; found = true; }
    if (!Number.isNaN(c)) { cacheRead += c; found = true; }
    const m = a['gen_ai.request.model'];
    if (typeof m === 'string' && m) model = m;
  }
  return found ? { input, output, cacheRead, model } : null;
}

async function fetchUsageUncached(msgId: string): Promise<TokenUsage | null> {
  if (!OTELITE_URL) return null;                 // 明示無効化
  if (now() < breakerOpenUntil) return null;     // circuit open
  const traceId = msgIdToTraceId(msgId);
  const url = `${OTELITE_URL}/api/traces/${traceId}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OTELITE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (res.status === 404) return null;         // この msg は telemetry なし
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    return extractUsageFromTrace(data, traceId);
  } catch {
    // timeout / 接続失敗 → breaker を開いて以降を即 null に
    breakerOpenUntil = now() + BREAKER_COOLDOWN_MS;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUsage(msgId: string): Promise<TokenUsage | null> {
  const hit = cache.get(msgId);
  if (hit && hit.expires > now()) return hit.usage;
  const usage = await fetchUsageUncached(msgId);
  cache.set(msgId, { usage, expires: now() + OTELITE_CACHE_TTL_MS });
  return usage;
}

// bounded-concurrency batch。返り値は msg_id → TokenUsage|null。
export async function fetchUsageMap(msgIds: string[]): Promise<Map<string, TokenUsage | null>> {
  const unique = [...new Set(msgIds)];
  const map = new Map<string, TokenUsage | null>();
  if (!OTELITE_URL || unique.length === 0) {
    for (const id of unique) map.set(id, null);
    return map;
  }
  let idx = 0;
  const worker = async (): Promise<void> => {
    while (idx < unique.length) {
      const id = unique[idx++];
      map.set(id, await fetchUsage(id));
    }
  };
  const n = Math.max(1, Math.min(OTELITE_CONCURRENCY, unique.length));
  await Promise.all(Array.from({ length: n }, worker));
  return map;
}

// ツリーの合計燃費 (N/A の msg は 0 として無視)。
export function sumUsage(usages: Iterable<TokenUsage | null>): TokenUsage {
  let input = 0, output = 0, cacheRead = 0;
  for (const u of usages) {
    if (!u) continue;
    input += u.input; output += u.output; cacheRead += u.cacheRead;
  }
  return { input, output, cacheRead, model: null };
}
