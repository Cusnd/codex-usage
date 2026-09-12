import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ErrorBox } from "../../widgets/ui.js";
import { cloudRequest } from '../../adapters/cloud-http.js';

export function CloudBind(){
  const [search]=useSearchParams(),[code,setCode]=useState(search.get('code')||''),[device,setDevice]=useState<{deviceName:string;approved:boolean;resumableDevices?:{id:string;name:string;revoked:boolean;paused:boolean}[]}|null>(null),[resume,setResume]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[done,setDone]=useState(false);
  async function action(approve=false){setBusy(true);setError('');try{if(approve){await cloudRequest('/api/v3/device-authorizations/approve','POST',{code,replaceDeviceId:resume||null});setDone(true);}else{setResume('');setDevice(await cloudRequest('/api/v3/device-authorizations/inspect','POST',{code}));}}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <section className="panel cloud-bind"><h1>绑定采集设备</h1><p>输入本地应用显示的绑定码，核对设备名称后加入你的云端空间。</p><label htmlFor="binding-code">绑定码</label><input id="binding-code" value={code} maxLength={9} onChange={e=>{setCode(e.target.value.toUpperCase());setDevice(null);setDone(false);}}/><button disabled={busy||code.length!==9} onClick={()=>void action()}>核对设备</button><ErrorBox error={error?new Error(error):undefined}/>
    {device&&!done&&<div className="notice"><h2>{device.deviceName}</h2><p>该设备可同步全部已解析用量、原标题、项目路径与账户额度。聊天和凭据保留在设备上。</p>{!!device.resumableDevices?.length&&<><label htmlFor="resume-device">设备身份</label><select id="resume-device" value={resume} disabled={busy||device.approved} onChange={e=>setResume(e.target.value)}><option value="">加入一台新设备</option>{device.resumableDevices.map(d=><option key={d.id} value={d.id}>接续 {d.name}{d.revoked?'（已撤销，历史保留）':d.paused?'（同步已暂停）':''}</option>)}</select>{resume&&<p>接续所选设备将保留其云端历史与暂停设置，替换上传凭证。原凭证将立即失效；仅在这台设备重装或丢失本机身份后使用。</p>}</>}<button className="primary-button" disabled={busy||device.approved} onClick={()=>void action(true)}>{device.approved?'设备已绑定':resume?'确认接续所选设备':'确认加入此设备'}</button></div>}
    {done&&<p className="notice" role="status">{resume?'设备身份已接续，保留原云端历史与暂停设置。':'设备已加入。本机将自动开始同步历史，其他设备继续保留。'}</p>}<p><Link to="/">返回用量总览</Link></p></section>;
}
