import type { Settings } from '../contracts/settings.js';

export type SQLInputValue = string | number | bigint | null;

export type Statement = { sql: string; params: SQLInputValue[]; one?: boolean };

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
