// Local-only browser acceptance entry. Production always deploys src/index.ts.
import worker from "../src/index";
import { SESSION_COOKIE, setCookie, sha256, token } from "../src/http";
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!["127.0.0.1", "localhost"].includes(url.hostname))
      return new Response("Local fixture only", { status: 403 });
    if (url.pathname === "/auth/github") {
      const id = "browser-fixture-user";
      await env.DB.prepare(
        "INSERT OR IGNORE INTO users(id,github_id,login,created_at) VALUES(?,?,?,?)",
      )
        .bind(id, "synthetic-browser-user", "browser-fixture", Date.now())
        .run();
      const session = token();
      await env.DB.prepare(
        "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
      )
        .bind(await sha256(session), id, Date.now() + 86400000)
        .run();
      const returnTo = url.searchParams.get("returnTo");
      return new Response(null, {
        status: 302,
        headers: {
          "Set-Cookie": setCookie(SESSION_COOKIE, session, 86400),
          Location:
            url.origin +
            (returnTo && /^\/bind\?code=[A-Z2-9-]+$/.test(returnTo)
              ? returnTo
              : "/"),
        },
      });
    }
    return worker.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
