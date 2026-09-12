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
import { v3Route } from './v3/routes';
import { advanceJobs } from './v3/jobs';
import { cleanupVersions } from './v3/snapshots';
import { versionGate } from './version-gate';
import { BUILD_VERSION, PACKAGE_VERSION, SYNC_VERSION } from '../../shared/cloud-version';

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
  async fetch(request:Request, env:Env, ctx?:ExecutionContext): Promise<Response> {
    const url = new URL(request.url),
      pathname = url.pathname;
    try {
      if (pathname === "/api/health" && request.method === "GET") {
        await env.DB.prepare("SELECT 1 FROM users LIMIT 1").first();
        await env.DB.prepare('SELECT resumed_device_id FROM device_authorizations LIMIT 0').all();
        await env.DB.prepare('SELECT sync_version FROM device_sync_versions LIMIT 0').all();
        // Prepare the current storage shape without reading any private rows.
        await env.DB.prepare(`SELECT r.applied_at,d.rebuild_job
          FROM v3_receipts r,v3_sync_domains d,v3_rebuild_candidates b,
          v3_project_sources p,v3_project_rules g,v3_entity_versions e,v3_read_leases q,
          v3_aggregate_members m,v3_operations o,v3_origin_operations u,v3_origin_operation_events a LIMIT 0`).all();
        return json({
          ok: true,
          schemaVersion: 3,
          usageProtocol: 3,
          syncVersion: SYNC_VERSION,
          buildVersion: BUILD_VERSION,
          packageVersion: PACKAGE_VERSION,
          loginConfigured: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
        });
      }
      // Production has one canonical origin. Local workerd uses the same configured origin in tests.
      if (
        (pathname.startsWith("/api/") || pathname.startsWith("/auth/")) &&
        url.origin !== env.APP_ORIGIN
      )
        return fail(403, "INVALID_ORIGIN", "请使用已配置的云端地址。");
      if (pathname === "/api/v3/me" && request.method === "GET") {
        const user = await sessionUser(request, env);
        return json({ user: { id: user.id, login: user.login } });
      }
      if (pathname === "/api/v3/me" && request.method === "DELETE") {
        requireSameOrigin(request, env);
        const user = await sessionUser(request, env);
        // Foreign keys cascade through devices, observations, sessions and approved requests.
        await env.DB.prepare("DELETE FROM users WHERE id=?")
          .bind(user.id)
          .run();
        return json({ ok: true }, 200, {
          "Set-Cookie": setCookie(SESSION_COOKIE, "", 0),
        });
      }
      const response =
        (await versionGate(request, env, pathname)) ||
        (await authRoute(request, env, pathname)) ||
        (await deviceRoute(request, env, pathname)) ||
        (await v3Route(request, env, pathname,ctx));
      if (response) return response;
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
    // Cleanup consumes at most 323 statements across the 100-domain page. Leave
    // headroom under D1's 1,000-query invocation limit, counting batch SQL too.
    await advanceJobs(env.DB,{maxSteps:200,maxQueries:600,budgetMs:20000});
    await cleanupVersions(env.DB);
  },
} satisfies ExportedHandler<Env>;
