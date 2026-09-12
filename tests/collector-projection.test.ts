import test from 'node:test';
import assert from 'node:assert/strict';
import {projectLine} from '../modules/collection/projection.js';
import {projectRecord} from '../modules/usage/normalize.js';

const original=(raw:string)=>projectRecord(JSON.parse(raw,(_key,value,context?:{source?:string})=>
  typeof value==='number'&&!Number.isSafeInteger(value)&&context?.source&&/^-?\d+$/.test(context.source)?context.source:value));

test('projection fast path preserves exact integer boundaries and the prior exponent/fraction semantics',()=>{
  const literals=['0','-0','1','999999999999999','9007199254740991','9007199254740992','9007199254740993','18446744073709551616','9'.repeat(128),'-9007199254740993','1e20','9e999','1.25','9007199254740993.0','9.007199254740993e15','"9007199254740993"','null','true'];
  for(const literal of literals){
    const raw=`{"type":"token_usage_record","timestamp":"2026-09-12T00:00:00Z","payload":{"response_id":"r","usage":{"total_tokens":${literal}}}}`;
    assert.deepEqual(projectLine(raw),original(raw),literal);
  }
  const raw='{"type":"token_usage_record","payload":{"usage":{"total_tokens":9007199254740993}}}';
  assert.equal((projectLine(raw).record!.payload.usage as {total_tokens:string}).total_tokens,'9007199254740993');
});

test('irrelevant long numeric strings, escapes, nested values and numeric metadata keep projection unchanged',()=>{
  const raws=[
    '{"type":"session_meta","payload":{"id":9007199254740993,"cwd":"/repo"}}',
    '{"type":"session_meta","payload":{"id":"t","unused":"\\\"9007199254740993\\\""}}',
    '{"type":"response_item","payload":{"unused":[{"n":9007199254740993}]}}',
    '{"type":"token_usage_record","payload":{"usage":{"total_tokens":7},"unused":"12345678901234567890"}}',
    '{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"total_tokens":9007199254740993}}}}',
  ];
  for(const raw of raws)assert.deepEqual(projectLine(raw),original(raw));
  for(const raw of ['{','{"n":01}','{"n":NaN}','{"n":9007199254740993,}'])assert.throws(()=>projectLine(raw),SyntaxError);
});
