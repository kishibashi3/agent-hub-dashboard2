// ── otelite usage 抽出 — 純粋関数群 (副作用なし・env 非依存) ─────────
//
// otelite trace 詳細レスポンスから token 燃費を抽出する純粋ロジック。
// constants.ts (env guard あり) を import しないので unit test から直接叩ける
// (issue #27 Suggestion 2)。ネットワーク / cache / breaker は otelite.ts 側。
//
// 受理形状は v1 `agent-hub/packages/dashboard/server.py` を正本として忠実移植:
//   - `_extract_span_usage` (L3922): attributes の 3 形状
//   - `_fetch_trace`        (L3989): top-level レスポンスの shaping

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
// v1 `_extract_span_usage` (server.py:3922) の受理形状を忠実移植:
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

// ツリーの合計燃費 (N/A の msg は 0 として無視)。
export function sumUsage(usages: Iterable<TokenUsage | null>): TokenUsage {
  let input = 0, output = 0, cacheRead = 0;
  for (const u of usages) {
    if (!u) continue;
    input += u.input; output += u.output; cacheRead += u.cacheRead;
  }
  return { input, output, cacheRead, model: null };
}
