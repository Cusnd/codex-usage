import {gzip,gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import { V3_MAX_WIRE_BYTES, V3_MAX_DECODED_BYTES, stableJson, type UploadBatch } from '../../contracts/sync.js';
import { validUploadBatch } from '../protocol/validate-upload.js';
import {sha256} from '../../collection/projection.js';
const compress=promisify(gzip),decompress=promisify(gunzip);
export async function encodeUpload(batch:UploadBatch) {
  if(!validUploadBatch(batch)||sha256(stableJson(batch.records))!==batch.records_hash)throw Object.assign(Error('invalid extracted batch'),{code:'INVALID_BATCH'});
  const raw=Buffer.from(stableJson(batch));if(raw.length>V3_MAX_DECODED_BYTES)throw Object.assign(Error('batch exceeds decoded budget'),{code:'RECORD_TOO_LARGE'});
  const wire=await compress(raw,{level:1});if(wire.length>V3_MAX_WIRE_BYTES)throw Object.assign(Error('batch exceeds wire budget'),{code:'RECORD_TOO_LARGE'});
  return {wire,wire_hash:sha256(wire),records_hash:batch.records_hash};
}
export async function decodeUpload(wire:Uint8Array):Promise<UploadBatch> {
  if(wire.byteLength>V3_MAX_WIRE_BYTES)throw Error('WIRE_LIMIT');
  const raw=await decompress(wire,{maxOutputLength:V3_MAX_DECODED_BYTES});const batch=JSON.parse(raw.toString('utf8'));
  if(!validUploadBatch(batch)||sha256(stableJson(batch.records))!==batch.records_hash)throw Error('INVALID_BATCH');return batch;
}
