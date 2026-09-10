import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach } from "vitest";
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    }
  }
}
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch(
    [
      "DELETE FROM users",
      "DELETE FROM device_authorizations",
      "DELETE FROM oauth_states",
    ].map((sql) => env.DB.prepare(sql)),
  );
});
