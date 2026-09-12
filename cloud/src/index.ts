import { authRoute, sessionUser } from "./auth";
import { deviceRoute } from "./devices";
import {
  fail,
  HttpError,
  json,
  requireSameOrigin,
  SESSION_COOKIE,
  setCookie,
} from "./http";
import { snapshotRoute } from "./snapshots";
import { usageSyncRoute, cleanupUsage } from './usage-sync';
import { usageQueryRoute } from './usage-query';
import { v3Route } from './v3/routes';
import { advanceJobs } from './v3/jobs';
import { cleanupVersions } from './v3/snapshots';

export async function cleanup(env: Env, now = Date.now()) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at<=?").bind(now),
    env.DB.prepare("DELETE FROM oauth_states WHERE expires_at<=?").bind(now),
    env.DB.prepare(
      "DELETE FROM device_authorizations WHERE expires_at<=?",
    ).bind(now),
  ]);
}
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url),
      pathname = url.pathname;
    try {
      if (pathname === "/api/health" && request.method === "GET") {
        await env.DB.prepare("SELECT 1 FROM users LIMIT 1").first();
        await env.DB.prepare('SELECT resumed_device_id FROM device_authorizations LIMIT 0').all();
        // Prepare the current storage shape without reading any private rows.
        await env.DB.prepare(`SELECT r.applied_at,d.rebuild_job,d.legacy_baseline_pending
          FROM v3_receipts r,v3_sync_domains d,v3_rebuild_candidates b,v3_legacy_heads l,
          v3_project_sources p,v3_project_rules g,v3_entity_versions e,v3_read_leases q,
          v3_aggregate_members m,v3_operations o,v3_origin_operations u,v3_origin_operation_events a LIMIT 0`).all();
        return json({
          ok: true,
          schemaVersion: 2,
          usageProtocol: 3,
          loginConfigured: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
        });
      }
      // Production has one canonical origin. Local workerd uses the same configured origin in tests.
      if (
        (pathname.startsWith("/api/") || pathname.startsWith("/auth/")) &&
        url.origin !== env.APP_ORIGIN
      )
        return fail(403, "INVALID_ORIGIN", "请使用已配置的云端地址。");
      const response =
        (await authRoute(request, env, pathname)) ||
        (await v3Route(request, env, pathname)) ||
        (await usageSyncRoute(request, env, pathname)) ||
        (await usageQueryRoute(request, env, pathname)) ||
        (await deviceRoute(request, env, pathname)) ||
        (await snapshotRoute(request, env, pathname));
      if (response) return response;
      if (pathname === "/api/v1/me" && request.method === "GET") {
        const user = await sessionUser(request, env);
        return json({ user: { id: user.id, login: user.login } });
      }
      if (pathname === "/api/v1/me" && request.method === "DELETE") {
        requireSameOrigin(request, env);
        const user = await sessionUser(request, env);
        // Foreign keys cascade through devices, snapshots, sessions and approved requests.
        await env.DB.prepare("DELETE FROM users WHERE id=?")
          .bind(user.id)
          .run();
        return json({ ok: true }, 200, {
          "Set-Cookie": setCookie(SESSION_COOKIE, "", 0),
        });
      }
      if (pathname.startsWith("/api/") || pathname.startsWith("/auth/"))
        return fail(404, "NOT_FOUND", "接口不存在。");
      return env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof HttpError)
        return json(
          { error: { code: error.code, message: error.message } },
          error.status,
          error.headers,
        );
      console.error(
        JSON.stringify({
          event: "request_failed",
          path: pathname,
          code: "INTERNAL_ERROR",
          errorType:
            error instanceof Error &&
            /^(Error|TypeError|RangeError|TimeoutError|AbortError)$/.test(error.name)
              ? error.name
              : "UnknownError",
          // Source positions identify failures without recording exception text,
          // request URLs, OAuth codes, cookies, or upstream credentials.
          source: error instanceof Error
            ? (error.stack?.match(/(?:index\.js|auth\.ts|http\.ts):\d+:\d+/g) || []).slice(0, 4)
            : [],
        }),
      );
      return json(
        {
          error: {
            code: "INTERNAL_ERROR",
            message: "云端服务暂时不可用，请稍后重试。",
          },
        },
        500,
      );
    }
  },
  async scheduled(_event, env) {
    await cleanup(env);
    for(let i=0;i<4;i++)await cleanupUsage(env);
    await advanceJobs(env.DB,{maxSteps:20,budgetMs:15000});
    await cleanupVersions(env.DB);
  },
} satisfies ExportedHandler<Env>;
