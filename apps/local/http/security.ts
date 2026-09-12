import { timingSafeEqual } from "node:crypto";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";
import { type LocalAppOptions } from '../options.js';

export async function configureHttp(app: FastifyInstance) {
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Codex 个人用量 API",
        version: "0.1.0",
        description: "账户统计与本地记录分别提供；token 使用十进制字符串。",
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api")) return;
    const host = req.headers.host?.split(":")[0];
    if (host && !["127.0.0.1", "localhost"].includes(host))
      return reply
        .code(403)
        .send({ error: { code: "LOCAL_ONLY", message: "仅允许本机访问。" } });
    if (req.headers.origin) {
      let allowed = false;
      try {
        const u = new URL(req.headers.origin);
        allowed =
          ["127.0.0.1", "localhost"].includes(u.hostname) &&
          ["http:", "https:"].includes(u.protocol);
      } catch {}
      if (!allowed)
        return reply.code(403).send({
          error: { code: "LOCAL_ONLY", message: "此请求来源不允许。" },
        });
    }
  });
  app.setErrorHandler((error, req, reply) => {
    const e = error as Error & { statusCode?: number; validation?: unknown };
    reply.code(e.statusCode || 500).send({
      error: {
        code: e.validation
          ? "INVALID_INPUT"
          : e.statusCode === 404
            ? "NOT_FOUND"
            : "REQUEST_FAILED",
        message: e.validation
          ? "请求参数无效，请检查日期、筛选或分页。"
          : e.statusCode
            ? e.message
            : "请求失败，请查看服务日志。",
      },
    });
    if (!e.statusCode) app.log.error({ err: e }, "request failed");
  });

  app.get('/openapi.json', async () => app.swagger());
}

export function registerControl(app:FastifyInstance,options:LocalAppOptions) {
  if (options.managed) {
    const managed = options.managed;
    app.post<{ Params: { action: string } }>('/_control/:action', async (req, reply) => {
      const received = Buffer.from(req.headers.authorization || '');
      const expected = Buffer.from(`Bearer ${managed.token}`);
      if (req.headers.origin || received.length !== expected.length || !timingSafeEqual(received, expected)) return reply.code(403).send({ error: 'Forbidden' });
      if (!['identity', 'stop'].includes(req.params.action)) return reply.code(404).send({ error: 'Not found' });
      if (req.params.action === 'stop') setTimeout(() => { void managed.shutdown(); }, 50);
      return { pid: process.pid, version: managed.version };
    });
  }

}
