import { type EntityKind, type SyncCut } from "../../contracts/sync.js";

export type ReadLease={user_id:string;lease_id:string;epoch:string;cut:number;deletion_version:number;organization_version:number;config_version:number;scope:'recent'|'full';from_at:string|null;device_ids:string;created_at:number;expires_at:number;max_expires_at:number;coverage:string;settings:string|null};

export type Version = {
    kind: EntityKind;
    entity_id: string;
    revision: number;
    hash: string;
    payload: string | null;
};

export const MINUTE = 60000;

export const leaseCut = (r: ReadLease): SyncCut => ({ dataset_epoch: r.epoch, commit_seq: r.cut, deletion_version: r.deletion_version, organization_version: r.organization_version, config_version: r.config_version });
