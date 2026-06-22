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
import {
  type TokenUsage,
  msgIdToTraceId,
  extractUsageFromTrace,
  sumUsage,
} from './otelite-usage.js';

// 純粋ロジック (受理形状の正規化・抽出・合算) は otelite-usage.ts に分離した
// (env 非依存 → unit test 可能、issue #27)。consumer の import 経路を変えないよう
// 型と sumUsage はここから re-export する。
export { type TokenUsage, sumUsage } from './otelite-usage.js';

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
