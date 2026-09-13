// Synthetic design experiment only. This is not the production sync codec.
// Run: node docs/design/benchmarks/sync-codec-2026-09-11.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { gzipSync, gunzipSync, brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';

const fields = ['event_id','revision','thread_id','turn_id','response_id','at_ms','origin_device_id','project_id','model','effort','input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens','quality'];
const dictionaryFields = new Set(['thread_id','origin_device_id','project_id','model','effort']);
const id = (kind, n) => createHash('sha256').update(kind + ':' + n).digest('hex').slice(0, 32);
function fixture(count) {
  return Array.from({length: count}, (_, i) => {
    const thread = Math.floor(i / 50), input = i % 997 === 0 ? 9007199254740993n : BigInt(1000 + (i * 7919) % 120000);
    const cached = input / 2n, output = BigInt(50 + (i * 193) % 6000);
    return {
      event_id: id('event', i), revision: 1, thread_id: id('thread', thread),
      turn_id: i % 19 === 0 ? null : id('turn', Math.floor(i / 5)),
      response_id: i % 23 === 0 ? null : id('response', i),
      at_ms: 1789084800000 + i * 713, origin_device_id: i % 29 === 0 ? null : 'device-' + thread % 3,
      project_id: 'project-' + thread % 16, model: 'synthetic-model-' + thread % 4,
      effort: ['low','medium','high'][thread % 3], input_tokens: input.toString(),
      cached_input_tokens: cached.toString(), cache_write_input_tokens: i % 7 === 0 ? null : '0',
      output_tokens: output.toString(), reasoning_output_tokens: i % 11 === 0 ? null : (output / 3n).toString(),
      total_tokens: (input + output).toString(), quality: i % 23 === 0 ? 1 : 0,
    };
  });
}
function objectBytes(events) { return Buffer.from(JSON.stringify({version: 1, events})); }
function objectDecode(bytes) { return JSON.parse(bytes.toString('utf8')).events; }
function tupleBytes(events) {
  const dictionaries = {}, maps = {};
  for (const field of dictionaryFields) { dictionaries[field] = []; maps[field] = new Map(); }
  const rows = events.map(event => fields.map(field => {
    const value = event[field];
    if (value === null || !dictionaryFields.has(field)) return value;
    const map = maps[field];
    if (!map.has(value)) { map.set(value, dictionaries[field].length); dictionaries[field].push(value); }
    return map.get(value);
  }));
  return Buffer.from(JSON.stringify({version: 1, fields, dictionaries, rows}));
}
function tupleDecode(bytes) {
  const block = JSON.parse(bytes.toString('utf8'));
  return block.rows.map(row => Object.fromEntries(block.fields.map((field, index) => [field,
    row[index] !== null && Object.hasOwn(block.dictionaries, field) ? block.dictionaries[field][row[index]] : row[index],
  ])));
}
const codecs = [
  {name:'objects+gzip1', encode:objectBytes, decode:objectDecode, compress:b=>gzipSync(b,{level:1}), inflate:gunzipSync},
  {name:'tuples+dict+gzip1', encode:tupleBytes, decode:tupleDecode, compress:b=>gzipSync(b,{level:1}), inflate:gunzipSync},
  {name:'tuples+dict+gzip6', encode:tupleBytes, decode:tupleDecode, compress:b=>gzipSync(b,{level:6}), inflate:gunzipSync},
  {name:'tuples+dict+brotli4', encode:tupleBytes, decode:tupleDecode, compress:b=>brotliCompressSync(b,{params:{[constants.BROTLI_PARAM_QUALITY]:4}}), inflate:brotliDecompressSync},
];
const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const round = n => Number(n.toFixed(3));
const results = [];
for (const count of [200, 2000, 20000]) {
  const events = fixture(count), samples = new Map(codecs.map(c=>[c.name, []]));
  // Rotate order to reduce systematic ordering bias; first three rounds warm up.
  for (let roundIndex = 0; roundIndex < 10; roundIndex++) {
    for (let k = 0; k < codecs.length; k++) {
      const codec = codecs[(k + roundIndex) % codecs.length];
      const a = performance.now(), raw = codec.encode(events), b = performance.now();
      const compressed = codec.compress(raw), c = performance.now();
      const restoredBytes = codec.inflate(compressed), d = performance.now();
      const restored = codec.decode(restoredBytes), e = performance.now();
      // Equality is outside timing and includes nulls and integers above 2^53.
      assert.deepEqual(restored, events);
      if (roundIndex >= 3) samples.get(codec.name).push({
        raw_bytes:raw.length, compressed_bytes:compressed.length,
        encode_ms:b-a, compress_ms:c-b, inflate_ms:d-c, decode_materialize_ms:e-d,
        sender_ms:c-a, receiver_ms:e-c,
      });
    }
  }
  for (const codec of codecs) {
    const rows = samples.get(codec.name);
    results.push({events:count, codec:codec.name, ...Object.fromEntries(Object.keys(rows[0]).map(key => [key, round(median(rows.map(r=>r[key])))]))});
  }
}
console.log(JSON.stringify({
  experiment:'synthetic sync encoding comparison', node:process.version, platform:process.platform, arch:process.arch,
  measured_at:new Date().toISOString(), warmup_rounds:3, measured_rounds:7, statistic:'median of each stage; independent medians need not add exactly',
  limitations:[
    'Synthetic normalized events, not captured user logs and not the full current v2 protocol.',
    'Sizes describe one logical block; large cases are not proposed upload request sizes.',
    'Synchronous compression is only for measurement; it is not proposed for the production UI thread.',
    'Receiver materializes equivalent objects for fairness; direct tuple-to-database insertion may have a different result.',
    'No network, database, browser, memory-peak, protocol metadata, checksum, or binary-codec measurements.',
    'Every round verifies full decoded equality, null preservation, and exact large-integer strings outside timing.',
  ], results,
}, null, 2));
