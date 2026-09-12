import { advanceHead, endGuard, guard, type Domain, type JobLease, type WriteDevice } from './store.js';

/** All prepared effects belong to one optimistic publication. Never execute them individually. */
export type PublicationPlan = {
  head: Domain;
  operationId: string;
  device?: WriteDevice;
  job?: JobLease;
  hasChanges: boolean;
  effects: D1PreparedStatement[];
};
export interface PublicationStore {
  commit(plan: PublicationPlan): Promise<void>;
}

/** D1 batch rolls back guard, facts, aggregates, receipts and head together on any failure. */
export function d1PublicationStore(db: D1Database): PublicationStore {
  return {
    async commit(plan) {
      const {head,operationId,device,job,hasChanges,effects}=plan;
      await db.batch([
        guard(db,head,operationId,device,job),
        ...effects,
        advanceHead(db,head,hasChanges),
        endGuard(db,head.user_id,operationId),
      ]);
    },
  };
}
