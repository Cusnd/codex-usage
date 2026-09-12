import { createHash, createHmac } from 'node:crypto';
import type { Store } from '../storage/sqlite.js';
import type { LimitObservation } from './refresh.js';
import { cloudErrorCodes,isCloudSnapshot,type CloudWindow,type CloudSnapshot } from '../contracts/cloud.js';
import type { CloudAccountSnapshot } from '../contracts/cloud-accounts.js';
import type { AccountUsage } from '../contracts/accounts.js';
import { CloudVersionError } from '../contracts/cloud-version.js';

type Transport=(route:string,method:string,body?:unknown)=>Promise<{response:Response;data:Record<string,any>}>;
type State={deviceId:string|null;nextAt:number;failures:number;error:string|null;accountSequence:number;accountHash:string|null;accountNextAt:number};
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
export function accountRef(identity: string | null, salt: string) {
  return identity
    ? createHmac("sha256", salt).update(identity).digest("hex")
    : null;
}
function window(w: CloudWindow | null): CloudWindow | null {
  return w
    ? {
        usedPercent: w.usedPercent,
        remainingPercent: w.remainingPercent,
        windowDurationMins: w.windowDurationMins,
        resetsAt: w.resetsAt,
      }
    : null;
}
// Deliberately enumerate fields: never serialize the account response or source errors.
export function cloudSnapshot(
  observation: LimitObservation,
  accountKey: string,
  deviceId: string,
  sequence: number,
): CloudSnapshot {
  const known = observation.identityKnown && !!observation.stableIdentity;
  const data = known ? observation.data : null;
  const error =
    observation.errorCode &&
    cloudErrorCodes.includes(
      observation.errorCode as (typeof cloudErrorCodes)[number],
    )
      ? (observation.errorCode as (typeof cloudErrorCodes)[number])
      : observation.errorCode
        ? "ACCOUNT_FAILED"
        : null;
  return {
    schemaVersion: 3,
    deviceId,
    sequence,
    accountRef: known
      ? accountRef(observation.stableIdentity!, accountKey)
      : null,
    collectedAt: data ? observation.collectedAt : null,
    attemptedAt: observation.attemptedAt,
    provider: data ? observation.provider : null,
    refreshInterval: observation.refreshInterval,
    status: !known ? "identity_unknown" : error || !data ? "error" : "ok",
    errorCode: !known
      ? error || "IDENTITY_UNKNOWN"
      : error || (!data ? "ACCOUNT_FAILED" : null),
    buckets: data
      ? data.buckets.map((b) => ({
          id: b.id,
          name: b.name,
          primary: window(b.primary),
          secondary: window(b.secondary),
        }))
      : [],
  };
}

export class AccountSync {
  private state:State;
  constructor(private store:Store,private transport:Transport,private observe:()=>Promise<LimitObservation>,
    private history?:()=>Promise<{data:AccountUsage|null;collectedAt:string|null;identityKey:string|null}>,private now:()=>number=Date.now) {
    store.db.exec("CREATE TABLE IF NOT EXISTS account_sync_state(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL)");
    const saved=store.one('SELECT value FROM account_sync_state WHERE id=1');
    this.state=saved?JSON.parse(saved.value):{deviceId:null,nextAt:0,failures:0,error:null,accountSequence:0,accountHash:null,accountNextAt:0};
  }
  status(){return {error:this.state.error};}
  private save(){this.store.run('INSERT INTO account_sync_state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',[JSON.stringify(this.state)]);}
  refreshAccounts(){
    this.state.accountNextAt=0;
    // An explicit resume bypasses the ordinary polling interval, not failure/Retry-After backoff.
    if(!this.state.failures)this.state.nextAt=0;
    this.save();
  }
  private async send(route:string,method:string,body?:unknown){
    const result=await this.transport(route,method,body);
    if(!result.response.ok){
      const wait=Number(result.response.headers.get('retry-after')||0)*1000;
      const error=Object.assign(new Error(result.data.error?.code||'SYNC_FAILED'),{route,status:result.response.status,wait,acceptedSequence:result.data.acceptedSequence});throw error;
    }return result.data;
  }
  async tick(deviceId:string,current:()=>boolean){
    if(!current()||this.now()<this.state.nextAt)return;
    if(this.state.deviceId!==deviceId){this.state={...this.state,deviceId,accountHash:null,accountNextAt:0};this.save();}
    try{
      const config=await this.send('collector/config','GET');if(!current())return;
      if(config.paused){this.state.nextAt=this.now()+60000;this.state.error='云端已暂停此设备。';this.save();return;}
      if(typeof config.accountKey!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(config.accountKey))throw new Error('INVALID_CONFIG');
      if(this.now()>=this.state.accountNextAt){
        const observation=await this.observe();if(!current())return;
        const quota=cloudSnapshot(observation,config.accountKey,deviceId,this.state.accountSequence+1),ref=quota.accountRef;
        if(!isCloudSnapshot(quota))throw Error('INVALID_ACCOUNT_OBSERVATION');
        let history=ref&&this.history?await this.history():null;if(!current())return;
        if(history?.identityKey!==observation.identityKey||history?.data?.accountId!==observation.data?.accountId)history=null;
        const data=history?.data;
        const safeHistory=data?{summary:{lifetimeTokens:data.summary.lifetimeTokens,peakDailyTokens:data.summary.peakDailyTokens,longestRunningTurnSec:data.summary.longestRunningTurnSec,
          currentStreakDays:data.summary.currentStreakDays,longestStreakDays:data.summary.longestStreakDays},dailyUsageBuckets:data.dailyUsageBuckets?.map(b=>({startDate:b.startDate,tokens:b.tokens}))??null}:null;
        const body:CloudAccountSnapshot={schemaVersion:3,quota,history:safeHistory,historyCollectedAt:safeHistory?history!.collectedAt:null};
        const digest=hash(JSON.stringify({...body,quota:{...quota,sequence:0}}));
        if(digest!==this.state.accountHash){
          // Persist the sequence before sending: interrupted attempts may safely resend a newer version.
          this.state.accountSequence++;this.save();await this.send('accounts/observations','PUT',body);if(!current())return;this.state.accountHash=digest;
        }
        this.state.accountNextAt=this.now()+60000;
      }
      this.state.nextAt=this.now()+15000;this.state.failures=0;this.state.error=null;this.save();
    }catch(error){if(!current())return;const e=error as Error&{route?:string;status?:number;wait?:number;acceptedSequence?:number};
      if(e.route==='accounts/observations'&&e.message==='STALE_SEQUENCE'&&Number.isSafeInteger(e.acceptedSequence)){this.state.accountSequence=Math.max(this.state.accountSequence,e.acceptedSequence!);this.state.accountHash=null;}
      this.state.failures++;this.state.error=e instanceof CloudVersionError?e.message:e.status===401?'设备已撤销，请重新绑定。':e.status===423?'云端已暂停此设备。':'用量同步失败，正在重试；已同步数据仍可查看。';
      this.state.nextAt=this.now()+Math.max(e.wait||0,Math.min(900000,5000*2**Math.min(this.state.failures,7)));this.save();
    }
  }
}
