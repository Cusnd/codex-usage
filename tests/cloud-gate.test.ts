import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { CloudVersionSession } from '../modules/web/shell/cloud-version-session.js';
import { cloudRequest } from '../modules/web/adapters/cloud-http.js';
import { SYNC_VERSION, SYNC_HEADER, type CloudCompatibility } from '../modules/contracts/cloud-version.js';

const good: CloudCompatibility = { compatible: true, requiredVersion: SYNC_VERSION, browserVersion: SYNC_VERSION,
  devices: [{ id: 'a', name: 'Synthetic device', compatible: true, syncVersion: SYNC_VERSION }] };
const status = (status: number) => Object.assign(new Error('Synthetic HTTP error'), { status });
const offline = () => Object.assign(new TypeError('Failed to fetch'), { code: 'CLOUD_NETWORK_ERROR' });
const accept = (session: CloudVersionSession) => session.succeed(session.begin(), good);

test('a new user or new document starts closed unless its authenticated bootstrap is compatible', () => {
  const a = new CloudVersionSession();
  assert.equal(a.state.allowed, false);
  accept(a);
  assert.equal(a.state.allowed, true);
  assert.equal(new CloudVersionSession().state.allowed, false);
  assert.equal(new CloudVersionSession(good).state.allowed, true);
  for (const changed of [{ compatible: false }, { requiredVersion: 'old' }, { browserVersion: 'old' }]) {
    assert.equal(new CloudVersionSession({ ...good, ...changed }).state.allowed, false);
  }
});

test('only an already verified session survives transient transport, server or rate-limit failures', () => {
  for (const error of [offline(), status(408), status(429), status(500), status(503), status(599)]) {
    const verified = new CloudVersionSession(good);
    verified.fail(verified.begin(), error);
    assert.deepEqual(verified.state, { allowed: true, transientFailure: true, invalidated: false });
    const fresh = new CloudVersionSession();
    fresh.fail(fresh.begin(), error);
    assert.equal(fresh.state.allowed, false);
    accept(verified);
    assert.equal(verified.state.transientFailure, false);
  }
});

test('authentication, authorization, protocol and unknown failures remove the permit; later offline failures cannot restore it', () => {
  for (const error of [status(401), status(403), status(400), status(404), status(426),
    new SyntaxError('Malformed response'), new TypeError('Malformed payload'), new Error('Unexpected failure'),
    Object.assign(new TypeError('Version mismatch'), { code: 'VERSION_MISMATCH' }),
    Object.assign(status(503), { code: 'VERSION_MISMATCH' })]) {
    const session = new CloudVersionSession(good);
    session.fail(session.begin(), error);
    assert.equal(session.state.allowed, false, String(error));
    session.fail(session.begin(), offline());
    assert.equal(session.state.allowed, false, 'old cached compatibility must not resurrect revoked access');
    accept(session);
    assert.equal(session.state.allowed, true, 'a new successful authenticated check can restore access');
  }
});

test('successful but incompatible responses immediately block old compatible data', () => {
  for (const value of [{ ...good, compatible: false }, { ...good, requiredVersion: 'old' }, { ...good, browserVersion: 'old' }]) {
    const session = new CloudVersionSession(good);
    session.succeed(session.begin(), value);
    assert.equal(session.state.allowed, false);
    session.fail(session.begin(), status(503));
    assert.equal(session.state.allowed, false);
  }
});

test('mismatch invalidation rejects pre-event success and requires a fresh check', () => {
  const session = new CloudVersionSession(good), inFlight = session.begin();
  session.invalidate();
  assert.equal(session.state.allowed, false);
  session.succeed(inFlight, good);
  assert.equal(session.state.allowed, false, 'a check started before the mismatch cannot reopen the panel');
  session.fail(session.begin(), offline());
  assert.equal(session.state.allowed, false);
  accept(session);
  assert.deepEqual(session.state, { allowed: true, transientFailure: false, invalidated: false });
});

test('out-of-order old checks cannot override a newer success or security rejection', () => {
  const session = new CloudVersionSession(good);
  const old = session.begin(), fresh = session.begin();
  session.fail(fresh, status(403));
  session.succeed(old, good);
  assert.equal(session.state.allowed, false);
  const staleFailure = session.begin();
  accept(session);
  session.fail(staleFailure, status(403));
  assert.equal(session.state.allowed, true);
});

test('fresh authenticated bootstrap avoids an initial duplicate query; stale or old-server responses still verify', async () => {
  for (const mode of ['fresh', 'stale', 'legacy'] as const) {
    let calls = 0;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new QueryObserver(client, { queryKey: ['cloud-version', mode],
      queryFn: async () => { calls++; return good; }, initialData: mode === 'legacy' ? undefined : good,
      initialDataUpdatedAt: Date.now() - (mode === 'stale' ? 15001 : 0), staleTime: 15000 });
    const off = observer.subscribe(() => {});
    try {
      assert.equal(calls, mode === 'fresh' ? 0 : 1);
      await observer.refetch({ cancelRefetch: false });
      assert.equal(calls, 1);
      await observer.refetch();
      assert.equal(calls, 2, 'the following periodic/explicit check still reaches the server');
      assert.deepEqual(observer.getCurrentResult().data, good);
    } finally { off(); client.clear(); }
  }
});

test('bootstrap query parameters preserve authentication/version diagnostics without exempting private API headers', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ user: { id: 'u' }, compatibility: good }), {
    headers: { 'Content-Type': 'application/json' },
  }));
  const result = await cloudRequest<{ user: { id: string }; compatibility: CloudCompatibility }>('/api/v3/me?bootstrap=1');
  assert.equal(result.user.id, 'u');
  assert.deepEqual(result.compatibility, good);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { message: 'Not signed in' } }), {
    status: 401, headers: { [SYNC_HEADER]: SYNC_VERSION, 'Content-Type': 'application/json' },
  }));
  await assert.rejects(cloudRequest('/api/v3/me?bootstrap=1'), { status: 401 });
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(cloudRequest('/api/v3/compatibility'), { code: 'CLOUD_NETWORK_ERROR' });
  t.mock.method(globalThis, 'fetch', async () => new Response('null'));
  await assert.rejects(cloudRequest('/api/v3/compatibility'), error => error instanceof TypeError && !('code' in error));
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  try {
    t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
    await assert.rejects(cloudRequest('/api/v3/devices?bootstrap=1'), { code: 'VERSION_MISMATCH' });
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
