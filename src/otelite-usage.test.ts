// otelite 純粋関数の unit test (issue #27 Suggestion 2 / Minor 1 parity)。
// 実行: `npm test` (node:test + ts-node/register、外部依存なし)。
//
// 主眼は Minor 1 (v1 _extract_span_usage parity): otelite が返し得る attribute
// 3 形状 (flat dict / JSON 文字列 / OTLP key-value list) + top-level bare array で
// いずれも token を抽出でき、⛽ が N/A に silent 縮退しないことを保証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  msgIdToTraceId,
  parseIntAttr,
  normalizeAttributes,
  extractSpans,
  extractUsageFromTrace,
  sumUsage,
} from './otelite-usage.js';

test('msgIdToTraceId: dashed UUID → dashless hex', () => {
  assert.equal(
    msgIdToTraceId('005fda96-6ce5-4493-bbde-a8507a361a01'),
    '005fda966ce54493bbdea8507a361a01',
  );
  assert.equal(msgIdToTraceId('no-dashes'.replace('-', '')), 'nodashes');
});

test('parseIntAttr: string / number 両対応、非数値は NaN', () => {
  assert.equal(parseIntAttr('100'), 100);     // flat dict / OTLP intValue(string)
  assert.equal(parseIntAttr(100), 100);       // number 実値
  assert.equal(parseIntAttr(100.7), 100);     // float は切り捨て (v1 _int 相当)
  assert.ok(Number.isNaN(parseIntAttr(undefined)));
  assert.ok(Number.isNaN(parseIntAttr(null)));
  assert.ok(Number.isNaN(parseIntAttr('abc')));
  assert.ok(Number.isNaN(parseIntAttr(true)));
});

test('normalizeAttributes (1) flat dict はそのまま', () => {
  const a = normalizeAttributes({ 'gen_ai.usage.input_tokens': 100 });
  assert.equal(a['gen_ai.usage.input_tokens'], 100);
});

test('normalizeAttributes (2) JSON 文字列を parse', () => {
  const a = normalizeAttributes('{"gen_ai.usage.input_tokens": 100}');
  assert.equal(a['gen_ai.usage.input_tokens'], 100);
});

test('normalizeAttributes (2) 壊れた JSON は {} (silent skip)', () => {
  assert.deepEqual(normalizeAttributes('{not json'), {});
});

test('normalizeAttributes (3) OTLP key-value list → flat', () => {
  const a = normalizeAttributes([
    { key: 'gen_ai.usage.input_tokens', value: { intValue: '100' } },
    { key: 'gen_ai.usage.output_tokens', value: { intValue: 50 } },
    { key: 'gen_ai.request.model', value: { stringValue: 'opus-4.8' } },
    { key: 'ratio', value: { doubleValue: 0.5 } },
  ]);
  assert.equal(a['gen_ai.usage.input_tokens'], '100');
  assert.equal(a['gen_ai.usage.output_tokens'], 50);
  assert.equal(a['gen_ai.request.model'], 'opus-4.8');
  assert.equal(a['ratio'], 0.5);
});

test('normalizeAttributes: 非対応形は {}', () => {
  assert.deepEqual(normalizeAttributes(undefined), {});
  assert.deepEqual(normalizeAttributes(null), {});
  assert.deepEqual(normalizeAttributes(42), {});
});

test('extractSpans: bare array / {spans} / 単一 dict / その他', () => {
  assert.deepEqual(extractSpans([{ a: 1 }]), [{ a: 1 }]);          // bare array
  assert.deepEqual(extractSpans({ spans: [{ a: 1 }] }), [{ a: 1 }]); // {spans}
  assert.deepEqual(extractSpans({ a: 1 }), [{ a: 1 }]);            // 単一 span 扱い
  assert.deepEqual(extractSpans(null), []);
});

const TRACE_ID = '005fda966ce54493bbdea8507a361a01';
const EXPECTED = { input: 100, output: 50, cacheRead: 20, model: 'opus-4.8' };

test('extractUsageFromTrace: flat dict 形 (現状の実機形)', () => {
  const data = {
    spans: [{
      attributes: {
        'gen_ai.usage.input_tokens': 100,
        'gen_ai.usage.output_tokens': 50,
        'gen_ai.usage.cache_read.input_tokens': 20,
        'gen_ai.request.model': 'opus-4.8',
      },
    }],
  };
  assert.deepEqual(extractUsageFromTrace(data, TRACE_ID), EXPECTED);
});

test('extractUsageFromTrace: attributes JSON 文字列形でも N/A に縮退しない', () => {
  const data = {
    spans: [{
      attributes: JSON.stringify({
        'gen_ai.usage.input_tokens': 100,
        'gen_ai.usage.output_tokens': 50,
        'gen_ai.usage.cache_read.input_tokens': 20,
        'gen_ai.request.model': 'opus-4.8',
      }),
    }],
  };
  assert.deepEqual(extractUsageFromTrace(data, TRACE_ID), EXPECTED);
});

test('extractUsageFromTrace: OTLP key-value list + top-level bare array でも抽出', () => {
  const data = [{
    attributes: [
      { key: 'gen_ai.usage.input_tokens', value: { intValue: '100' } },
      { key: 'gen_ai.usage.output_tokens', value: { intValue: '50' } },
      { key: 'gen_ai.usage.cache_read.input_tokens', value: { intValue: '20' } },
      { key: 'gen_ai.request.model', value: { stringValue: 'opus-4.8' } },
    ],
  }];
  assert.deepEqual(extractUsageFromTrace(data, TRACE_ID), EXPECTED);
});

test('extractUsageFromTrace: token attribute 皆無なら null (= ⛽ N/A)', () => {
  const data = { spans: [{ attributes: { 'gen_ai.request.model': 'opus-4.8' } }] };
  assert.equal(extractUsageFromTrace(data, TRACE_ID), null);
});

test('extractUsageFromTrace: message.id 不一致の span は除外', () => {
  const data = {
    spans: [{
      attributes: {
        'message.id': '11111111-1111-1111-1111-111111111111',
        'gen_ai.usage.input_tokens': 999,
      },
    }],
  };
  assert.equal(extractUsageFromTrace(data, TRACE_ID), null);
});

test('sumUsage: null は 0 として無視、合算', () => {
  const sum = sumUsage([
    { input: 10, output: 5, cacheRead: 1, model: 'a' },
    null,
    { input: 20, output: 7, cacheRead: 2, model: 'b' },
  ]);
  assert.deepEqual(sum, { input: 30, output: 12, cacheRead: 3, model: null });
});
