import { useQuery } from "@tanstack/react-query";
import type { CloudSource } from "../../../contracts/cloud-accounts.js";
import { useCloudSync } from "../../data/cloud-provider.js";
import { cloudRequest } from '../../adapters/cloud-http.js';

export function useCloudDevices(){const sync=useCloudSync();return useQuery({queryKey:['cloud-devices'],queryFn:({signal})=>cloudRequest<{devices:CloudSource[]}>('/api/v3/devices','GET',undefined,signal),enabled:sync?.online!==false,refetchInterval:sync?.online===false?false:15000});}

export function sourceState(d:CloudSource){return d.historyDeleting?'正在删除云端历史 · 设备已撤销':d.deletionStatus==='failed'?'删除未完成 · 设备已撤销':d.historyDeleted?'历史已删除 · 设备已撤销':d.revoked?'已撤销 · 历史保留':d.paused?'同步已暂停':d.error?'同步失败':!d.receivedAt?'等待首次同步':Date.now()-Date.parse(d.receivedAt)>180000?'设备离线或未更新':!d.initialComplete?'历史同步中':'最近已同步';}
