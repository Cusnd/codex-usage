import { type FramingMetrics } from "./framing.js";
import { type UploadBatch, type SyncMetadata } from "../contracts/sync.js";
import type { ExtractionContext, SourceKind, OriginEvidence } from "../usage/types.js";

export type SourceState = {
    context: ExtractionContext;
    chain: string;
    trusted: boolean;
};

export type Source = {
    id: string;
    path: string;
    identity: string;
    kind: SourceKind;
    generation: number;
    version: number;
    offset: number;
    size: number;
    mtime: string;
    state: string;
    prefix_length: number;
    prefix_sha: string;
    tail_start: number;
    tail_sha: string;
    begun: number;
    complete: number;
    issues: number;
    available: number;
    caught_up: number;
    reset_required: number;
};

export type CollectionMetrics=FramingMetrics&{discovered:number;processed:number;unchanged:number;renamed:number;generations_started:number;selected_records:number;issues:number;batches:number;source_yields:number;check_bytes_read:number;audit_bytes_read:number;errors:{source_id:string|null;code:string}[];wall_ms:number};

export type CollectorOptions = {
    sourceRoot: string;
    stateRoot?: string;
    identityFile?: string | null;
    collectorId?: string;
    chunkBytes?: number;
    maxLineBytes?: number;
    maxBatchBytes?: number;
    maxBatchRecords?: number;
    checkpointBytes?: number;
    maxPassBytes?: number;
    onBatch?: (batch: UploadBatch) => void;
    onCycle?: (metrics: CollectionMetrics) => void;
    onError?: (error: unknown) => void;
    resolveProject?: (cwd: string | null, threadId: string) => Promise<{
        id: string | null;
        metadata?: SyncMetadata[];
    }>;
    origin?: (source: Source, locator: number) => OriginEvidence;
    beforeCommit?: (batch: UploadBatch) => void;
    afterCommit?: (batch: UploadBatch) => void;
};
