import type { Filter } from '../contracts/query.js';
import { type SQLInputValue } from './plan.js';

export const fieldMap = {
    project: "project",
    model: "model",
    effort: "effort",
    thread: "thread_id",
} as const;

export type QueryFilter = Filter & {
    threadIds?: string[];
    q?: string;
    /** Additional project IDs whose display names match q in the caller's fixed view. */
    qProjects?: string[];
    turnId?: string | null;
    searchTurns?: boolean;
};

export function where(f: QueryFilter) {
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];
    if (f.threadIds !== undefined) {
        conditions.push("thread_id IN (SELECT value FROM json_each(?))");
        params.push(JSON.stringify(f.threadIds));
    }
    for (const [field, value] of [
        ["at >=", f.from],
        ["at <", f.to],
        ["project =", f.project],
        ["model =", f.model],
        ["effort =", f.effort],
        ["thread_id =", f.threadId],
    ] as const) {
        if (value !== undefined) {
            conditions.push(`${field} ?`);
            params.push(field.startsWith("at") ? new Date(value).toISOString() : value);
        }
    }
    for (const field of new Set([
        ...(f.unknown ? [f.unknown] : []),
        ...(f.unknowns || []),
    ]))
        conditions.push(`${fieldMap[field]} IS NULL`);
    if (f.turnId !== undefined) {
        conditions.push("turn_id IS ?");
        params.push(f.turnId);
    }
    if (f.q?.trim()) {
        const needle = f.q.trim();
        conditions.push(`(instr(lower(thread_id),lower(?))>0 OR instr(lower(COALESCE(project,'')),lower(?))>0 OR thread_id IN (SELECT id FROM threads WHERE instr(lower(COALESCE(title,'')),lower(?))>0)${f.searchTurns ? " OR instr(lower(COALESCE(turn_id,'')),lower(?))>0" : ""}${f.qProjects?.length ? " OR project IN(SELECT value FROM json_each(?))" : ""})`);
        params.push(needle, needle, needle);
        if (f.searchTurns)
            params.push(needle);
        if (f.qProjects?.length)
            params.push(JSON.stringify(f.qProjects));
    }
    return {
        sql: conditions.length ? "WHERE " + conditions.join(" AND ") : "",
        params,
    };
}
