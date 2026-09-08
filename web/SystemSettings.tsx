import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Check, Copy, Globe2, Terminal } from 'lucide-react';
import { api, mutate } from './api';
import './system-settings.css';

type Startup = { supported: boolean; enabled: boolean; conflict?: boolean };
export function SystemSettings() {
  const query = useQuery({ queryKey: ['system', 'autostart'], queryFn: () => api<Startup>('system/autostart') });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const state = query.data?.data;
  const changeStartup = async () => {
    setBusy(true); setError('');
    try { await mutate<Startup>('system/autostart', { enabled: !state?.enabled }); await query.refetch(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="panel settings-panel startup-panel">
    <h2>启动与访问</h2>
    <div className="startup-row">
      <div className="startup-copy">
        <h3 id="startup-label">登录 Windows 后后台启动</h3>
        <p id="startup-description">安静地启动本地服务，不弹出浏览器。关闭网页后仍可随时访问。</p>
      </div>
      <div className="startup-control">
        <span className="startup-state" aria-live="polite">{busy ? '更新中…' : query.isPending ? '读取中…' : !state ? '状态未知' : state.enabled ? '已开启' : '已关闭'}</span>
        <button id="autostart" className="startup-switch" type="button" role="switch" aria-labelledby="startup-label" aria-describedby="startup-description"
          aria-checked={state?.enabled ?? false} disabled={busy || !state?.supported || !!state.conflict} onClick={changeStartup}>
          <span className="startup-switch-track"><span className="startup-switch-thumb" /></span>
        </button>
      </div>
    </div>
    {(error || query.error || state?.conflict) && <p className="startup-error" role="alert">{error || query.error?.message || '存在非本工具管理的启动项，请先检查冲突。'}</p>}
    <div className="access-methods">
      <div className="access-method">
        <div className="access-label"><Globe2 size={15} aria-hidden="true" /><span>浏览器入口</span></div>
        <a className="access-domain" href="https://usage.esoren.com" rel="noreferrer">usage.esoren.com<ArrowUpRight size={17} aria-hidden="true" /></a>
        <p>服务启动后，输入域名即可打开本机工作台。</p>
      </div>
      <div className="access-method">
        <div className="access-label"><Terminal size={15} aria-hidden="true" /><span>命令行入口</span></div>
        <div className="access-command"><code>codex-usage</code><button type="button" className="copy-command" aria-label={copied ? '命令已复制' : '复制打开命令'} onClick={async () => {
          try { await navigator.clipboard.writeText('codex-usage'); setCopied(true); }
          catch { setError('复制失败，请手动选择 codex-usage 命令。'); }
        }}>{copied ? <Check size={16} /> : <Copy size={16} />}</button><span className="copy-feedback" aria-live="polite">{copied ? '已复制' : ''}</span></div>
        <p>自动启动服务并打开页面，离线也能使用。</p>
      </div>
    </div>
    <details className="access-details">
      <summary>关于域名与本地访问</summary>
      <p>域名需要联网，会跳转到当前设备的 <code>127.0.0.1:8765</code>，地址栏随后显示本地地址。它不能代替安装或启动服务，也不能从手机访问电脑。使用其他端口时，请直接打开对应的本地地址。</p>
    </details>
  </section>;
}
