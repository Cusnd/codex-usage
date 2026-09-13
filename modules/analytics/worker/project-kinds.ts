import {where} from '../filter.js';
import type {ProjectKindsPlan,QueryFilter} from '../query-engine.js';
import type {ReadLeaseMetadata} from '../../sync/reads/snapshots.js';

/** Prefer indexed matched membership only for a genuinely bounded range or identity filter. */
export function cloudProjectKinds(lease:ReadLeaseMetadata,filter:QueryFilter):ProjectKindsPlan {
  const span=filter.from&&filter.to?Date.parse(filter.to)-Date.parse(filter.from):Infinity;
  const matched=!!filter.project||!!filter.threadId||!!filter.threadIds?.length||Number.isFinite(span)&&span>0&&span<=31*86400000;
  if(!matched)return {sql:`SELECT json_extract(payload,'$.logical_project_id') project,
    CASE WHEN MIN(CASE WHEN json_extract(payload,'$.kind')='session' THEN 1 ELSE 0 END)=1 THEN 'session'
      WHEN MAX(CASE WHEN json_extract(payload,'$.kind') IN ('git','app') THEN 1 ELSE 0 END)=1 THEN 'project' ELSE 'unknown' END kind
    FROM versions WHERE kind='project' AND json_extract(payload,'$.subtype')='source'
      AND json_extract(payload,'$.logical_project_id') IS NOT NULL GROUP BY project`,params:[]};
  const w=where(filter);
  return {sql:`WITH selected AS MATERIALIZED (SELECT DISTINCT project FROM effective_events ${w.sql})
    SELECT selected.project,
      CASE WHEN MIN(CASE WHEN json_extract(source.payload,'$.kind')='session' THEN 1 ELSE 0 END)=1 THEN 'session'
        WHEN MAX(CASE WHEN json_extract(source.payload,'$.kind') IN ('git','app') THEN 1 ELSE 0 END)=1 THEN 'project' ELSE 'unknown' END kind
    FROM selected
    CROSS JOIN v3_entity_versions logical ON logical.user_id=? AND logical.epoch=? AND logical.kind='project'
      AND logical.entity_id='logical:'||selected.project AND logical.valid_from<=? AND (logical.valid_to IS NULL OR ?<logical.valid_to) AND logical.payload IS NOT NULL
    CROSS JOIN json_each(json_extract(logical.payload,'$.project.members')) member
    CROSS JOIN v3_entity_versions source ON source.user_id=? AND source.epoch=? AND source.kind='project'
      AND source.entity_id='source:'||member.value AND source.valid_from<=? AND (source.valid_to IS NULL OR ?<source.valid_to) AND source.payload IS NOT NULL
    GROUP BY selected.project`,params:[...w.params,lease.user_id,lease.epoch,lease.cut,lease.cut,lease.user_id,lease.epoch,lease.cut,lease.cut]};
}
