import { V3_CONTENT_TYPE, V3_MAX_DECODED_BYTES, V3_MAX_WIRE_BYTES, stableJson, type UploadBatch } from '../../contracts/sync.js';
import { validUploadBatch } from '../protocol/validate-upload.js';
import { fail, HttpError, sha256 } from '../../platform/worker/http.js';

async function bounded(stream:ReadableStream<Uint8Array>,max:number):Promise<Uint8Array> {
  const reader=stream.getReader(),parts:Uint8Array[]=[];let size=0;
  try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>max){await reader.cancel();fail(413,'BODY_TOO_LARGE','同步批次超过字节限制。');}parts.push(next.value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let at=0;for(const p of parts){bytes.set(p,at);at+=p.byteLength;}return bytes;
}
export async function hashBytes(value:Uint8Array):Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',value))].map(n=>n.toString(16).padStart(2,'0')).join('');
}
export async function decodeWire(wire:Uint8Array):Promise<UploadBatch> {
  if(wire.byteLength>V3_MAX_WIRE_BYTES)fail(413,'BODY_TOO_LARGE','同步批次超过字节限制。');
  let value:unknown;
  try {
    const stream=new Response(wire).body!.pipeThrough(new DecompressionStream('gzip'));
    const bytes=await bounded(stream,V3_MAX_DECODED_BYTES);
    value=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes));
  }catch(error){if(error instanceof HttpError)throw error;return fail(400,'INVALID_GZIP','同步批次不是有效的 gzip JSON。');}
  if(!validUploadBatch(value))return fail(400,'INVALID_BATCH','同步批次字段、来源或记录无效。');
  if(await sha256(stableJson(value.records))!==value.records_hash)fail(400,'HASH_MISMATCH','记录摘要不匹配。');
  for(const source of value.sources)if(await sha256(stableJson(source.context))!==source.context_hash)fail(400,'HASH_MISMATCH','来源上下文摘要不匹配。');
  for(const row of value.records)if(await sha256(stableJson([value.collector_id,row.source_id,row.generation,row.locator]))!==row.observation_id)fail(400,'OBSERVATION_ID_MISMATCH','观察身份与来源位置不匹配。');
  return value;
}
export async function readUpload(request:Request):Promise<{batch:UploadBatch;wire:Uint8Array;wireHash:string}> {
  if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!==V3_CONTENT_TYPE)fail(415,'GZIP_REQUIRED','请使用 v3 gzip 同步媒体类型。');
  if(request.headers.has('content-encoding'))fail(415,'AMBIGUOUS_ENCODING','应用压缩格式不使用 Content-Encoding。');
  const length=request.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>V3_MAX_WIRE_BYTES))fail(413,'BODY_TOO_LARGE','同步批次超过字节限制。');
  if(!request.body)return fail(400,'INVALID_BATCH','缺少同步批次。');
  const wire=await bounded(request.body,V3_MAX_WIRE_BYTES),batch=await decodeWire(wire);
  return {batch,wire,wireHash:await hashBytes(wire)};
}
