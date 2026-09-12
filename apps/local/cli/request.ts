import { base } from "../../../modules/platform/node/runtime.js";

export async function request(route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    let url = base;
    if (process.env.CODEX_USAGE_URL) {
        const override = new URL(process.env.CODEX_USAGE_URL);
        if (override.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(override.hostname) || override.username || override.password || override.pathname !== '/' || override.search || override.hash)
            throw new Error('CODEX_USAGE_URL must be an HTTP loopback origin.');
        url = override.origin;
    }
    const response = await fetch(`${url}/api/${route}`, {
        method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
    });
    const result = await response.json() as any;
    if (!response.ok)
        throw new Error(result.error?.message || `HTTP ${response.status}`);
    return result;
}
