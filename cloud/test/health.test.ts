import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import worker from '../../apps/cloud/index.js';

it('reports v3 readiness only when the current storage shape is available', async () => {
  const request = () => worker.fetch(new Request('https://quota.esoren.com/api/health'), env);
  const ready = await request();
  expect(ready.status).toBe(200);
  expect(await ready.json()).toMatchObject({ ok: true, schemaVersion:3, usageProtocol: 3 });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    for (const table of ['v3_rebuild_candidates', 'v3_origin_operations']) {
      await env.DB.prepare(`ALTER TABLE ${table} RENAME TO unavailable_${table}`).run();
      try {
        const incomplete = await request();
        expect(incomplete.status).toBe(500);
        expect(await incomplete.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: '云端服务暂时不可用，请稍后重试。' } });
      } finally {
        await env.DB.prepare(`ALTER TABLE unavailable_${table} RENAME TO ${table}`).run();
      }
    }
  } finally {
    log.mockRestore();
  }
});
