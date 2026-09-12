import staticFiles from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import { packageRoot } from "../../../modules/platform/node/runtime.js";
import type { FastifyInstance } from "fastify";

export async function registerAssets(app:FastifyInstance) {
  const web = path.join(packageRoot, "dist/web");
  if (existsSync(path.join(web, "index.html"))) {
    await app.register(staticFiles, { root: web, prefix: "/" });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api")
        ? reply
            .code(404)
            .send({ error: { code: "NOT_FOUND", message: "接口不存在。" } })
        : reply.sendFile("index.html"),
    );
  }

}
