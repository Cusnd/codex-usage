import type { Settings } from '../contracts/settings.js';
import type { Filter } from '../contracts/query.js';

export type QueryFilter = Filter & {
    threadIds?: string[];
    q?: string;
    /** Additional project IDs whose display names match q in the caller's fixed view. */
    qProjects?: string[];
    turnId?: string | null;
    searchTurns?: boolean;
};


export type SQLInputValue = string | number | bigint | null;

export type Statement = { sql: string; params: SQLInputValue[]; one?: boolean };

/** One row per non-null logical identity, classified from all of its evidence. */
export type ProjectKindsPlan = { sql: string; params: SQLInputValue[] };
export type QueryEngineOptions = {
 /** The query shares the caller's snapshot and may use runtime-specific tables. */
 projectKinds?: (filter: QueryFilter) => ProjectKindsPlan;
};

export interface QueryStore {
 settings(): Settings;
 all(sql: string, params?: SQLInputValue[]): Generator<Statement, Record<string, any>[], any>;
 one(sql: string, params?: SQLInputValue[]): Generator<Statement, Record<string, any> | undefined, any>;
}

export function queryStore(settings: Settings): QueryStore {
 return { settings: () => settings,
 *all(sql, params = []) { return yield { sql, params }; },
 *one(sql, params = []) { return yield { sql, params, one: true }; } };
}

export type QueryResult<G> = G extends Generator<Statement, infer R, any> ? R : never;
