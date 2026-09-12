import { stableJson } from '../../../shared/sync-v3';
import { fail,sha256 } from '../http';
import { advanceHead,domain,endGuard,entityStatements,guard,isCasFailure } from './store';
import { loadSettings,validSettings } from './queries';

/** Settings patches use absolute values; explicit operation IDs replay their original result. */
export async function updateSettings(db:D1Database,user:string,body:unknown) {
  const allowed=['localInterval','accountInterval','timezone','timezoneMode','costEnabled','officialApiPricing','modelPrices','operation_id','base_config_version'];
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!allowed.includes(k)))fail(400,'INVALID_SETTINGS','设置字段无效。');
  const {operation_id:operation,base_config_version:base,...patch}=body as Record<string,unknown>;
  if(operation!==undefined&&(typeof operation!=='string'||!operation||operation.length>256)||base!==undefined&&(!Number.isSafeInteger(base)||Number(base)<0))fail(400,'INVALID_SETTINGS_OPERATION','设置操作无效。');
  const hash=await sha256(stableJson(body));
  for(let attempt=0;attempt<3;attempt++){
    if(operation){const saved=await db.prepare('SELECT content_hash,result FROM v3_operations WHERE user_id=? AND operation_id=?').bind(user,operation).first<{content_hash:string;result:string}>();if(saved){if(saved.content_hash!==hash)fail(409,'OPERATION_CONFLICT','该操作标识已对应其他内容。');return JSON.parse(saved.result);}}
    const h=await domain(db,user);if(h.mode!=='ready')fail(409,'DATASET_UPDATING','历史基线正在构建，请稍后修改设置。');if(base!==undefined&&base!==h.config_version)fail(409,'CONFIG_VERSION_CONFLICT','设置已更新，请刷新后重试。');
    const old=await loadSettings(db,user),value={...old,...patch};if(!validSettings(value))fail(400,'INVALID_SETTINGS','设置无效。');
    const changed=stableJson(value)!==stableJson(old),revision=h.config_version+Number(changed),result={settings:value,config_version:revision};if(!changed&&!operation)return result;
    const op=crypto.randomUUID(),statements:D1PreparedStatement[]=[guard(db,h,op)];
    if(changed)statements.push(db.prepare('INSERT INTO v3_settings(user_id,revision,payload) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload').bind(user,revision,stableJson(value)),...await entityStatements(db,h,[{kind:'settings',id:'preferences',revision,value}]),advanceHead(db,h,true),db.prepare('UPDATE v3_sync_domains SET config_version=? WHERE user_id=?').bind(revision,user));
    if(operation)statements.push(db.prepare('INSERT INTO v3_operations(user_id,operation_id,content_hash,result) VALUES(?,?,?,?)').bind(user,operation,hash,stableJson(result)));statements.push(endGuard(db,user,op));
    try{await db.batch(statements);return result;}catch(error){if(isCasFailure(error)||error instanceof Error&&/UNIQUE constraint failed.*v3_operations/.test(error.message))continue;throw error;}
  }
  return fail(409,'WRITE_CONFLICT','设置正在更新，请重试同一操作。');
}
