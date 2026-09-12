import { SYNC_HEADER, SYNC_VERSION } from '../../modules/contracts/cloud-version.js';
/** Existing transport regressions model the current protocol independently of source fingerprint. */
export function versionedFetch(transport: typeof fetch, build: () => string | null = () => SYNC_VERSION): typeof fetch {
  return async (input, init) => {
    const route = new URL(String(input)).pathname;
    const actual = build();
    if (route === '/api/health' || route === '/api/v3/collector/handshake') return Response.json({ok:true},{headers:actual?{[SYNC_HEADER]:actual}:{}});
    const response = await transport(input, init);
    if(actual)response.headers.set(SYNC_HEADER, actual);
    return response;
  };
}
