import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { test } from 'node:test';
import { createApp } from '../server/app.js';

test('managed shutdown releases a connected client that has not sent an HTTP request', async () => {
  const { app } = await createApp({ database: ':memory:', startup: false,
    managed: { token: 'test-only', version: 'test', shutdown: async () => {} } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const socket = createConnection({ host: '127.0.0.1', port: address.port });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const closed = await Promise.race([app.close().then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2000); })]);
    assert.equal(closed, true, 'stop must not wait for an unused client connection');
  } finally {
    clearTimeout(timer);
    socket.destroy();
    await app.close();
  }
});
