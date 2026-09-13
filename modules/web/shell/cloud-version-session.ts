import { SYNC_VERSION, type CloudCompatibility } from '../../contracts/cloud-version.js';

type Check = { generation: number; sequence: number };
export type CloudVersionState = { allowed: boolean; transientFailure: boolean; invalidated: boolean };

const matches = (value: CloudCompatibility | undefined) => value?.compatible === true
  && value.requiredVersion === SYNC_VERSION && value.browserVersion === SYNC_VERSION;

function transient(error: unknown): boolean {
  const value = error as { status?: number; code?: string } | null;
  if (value?.code === 'VERSION_MISMATCH') return false;
  if (typeof value?.status === 'number') return value.status === 408 || value.status === 429 || value.status >= 500 && value.status <= 599;
  // Only cloudRequest's fetch rejection is marked; parse/programming errors fail closed.
  return value?.code === 'CLOUD_NETWORK_ERROR';
}

/** A permit lasts only for this mounted user's session; it is never persisted or shared. */
export class CloudVersionSession {
  private generation = 0;
  private sequence = 0;
  state: CloudVersionState;

  constructor(bootstrap?: CloudCompatibility) {
    this.state = { allowed: matches(bootstrap), transientFailure: false, invalidated: false };
  }

  begin(): Check { return { generation: this.generation, sequence: ++this.sequence }; }
  private current(check: Check) { return check.generation === this.generation && check.sequence === this.sequence; }

  succeed(check: Check, value: CloudCompatibility): CloudVersionState {
    if (this.current(check)) this.state = { allowed: matches(value), transientFailure: false, invalidated: false };
    return this.state;
  }

  fail(check: Check, error: unknown): CloudVersionState {
    if (this.current(check)) this.state = { ...this.state,
      allowed: this.state.allowed && transient(error), transientFailure: this.state.allowed && transient(error) };
    return this.state;
  }

  invalidate(): CloudVersionState {
    this.generation++;
    this.state = { allowed: false, transientFailure: false, invalidated: true };
    return this.state;
  }
}
