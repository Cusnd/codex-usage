// Public cloud protocol. Keep this module independent of local storage and login data.
export const CLOUD_ORIGIN = "https://quota.esoren.com";
export const CLOUD_SYNC_MIN_MS = 60_000;
export const CLOUD_MAX_BODY_BYTES = 65_536;
export type CloudWindow = {
  usedPercent: number | null;
  remainingPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: string | null;
};
export type CloudBucket = {
  id: string;
  name: string;
  primary: CloudWindow | null;
  secondary: CloudWindow | null;
};
export const cloudErrorCodes = [
  "ACCOUNT_FAILED",
  "LOGIN_EXPIRED",
  "UNSUPPORTED_LOGIN",
  "IDENTITY_CHANGED",
  "IDENTITY_UNKNOWN",
  "CREDENTIALS_MISSING",
  "CREDENTIALS_INVALID",
  "CREDENTIALS_UNREADABLE",
  "UNSUPPORTED_STORE",
  "CLI_NOT_FOUND",
  "CLI_FAILED",
  "UNSUPPORTED_METHOD",
  "RESPONSE_INVALID",
  "HTTP_STATUS",
  "HTTP_NETWORK",
  "HTTP_TIMEOUT",
  "CANCELLED",
] as const;
export type CloudErrorCode = (typeof cloudErrorCodes)[number];
export type CloudSnapshot = {
  schemaVersion: 1;
  deviceId: string;
  sequence: number;
  accountRef: string | null;
  collectedAt: string | null;
  attemptedAt: string;
  provider: "app-server" | "http" | null;
  refreshInterval: number;
  status: "ok" | "error" | "identity_unknown";
  errorCode: CloudErrorCode | null;
  buckets: CloudBucket[];
};
export type CloudBinding = {
  verificationUrl: string;
  userCode: string;
  expiresAt: string;
};
export type CloudStatus = {
  origin: string;
  connected: boolean;
  enabled: boolean;
  revokePending: boolean;
  deviceId: string | null;
  deviceName: string | null;
  userLogin: string | null;
  binding: CloudBinding | null;
  collectedAt: string | null;
  uploadedAt: string | null;
  nextUploadAt: string | null;
  pending: boolean;
  running: boolean;
  error: string | null;
};
export type CloudDevice = { id: string; name: string; boundAt: string };
export type CloudQuota = {
  snapshot: CloudSnapshot | null;
  receivedAt: string | null;
};

const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
function keys(v: Record<string, unknown>, expected: string[]) {
  return (
    Object.keys(v).length === expected.length &&
    expected.every((k) => Object.hasOwn(v, k))
  );
}
const text = (v: unknown, max: number) =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(v);
const iso = (v: unknown) =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v));
const percent = (v: unknown) =>
  v === null ||
  (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100);
const nullableIso = (v: unknown) => v === null || iso(v);
function validWindow(v: unknown): v is CloudWindow | null {
  if (v === null) return true;
  return (
    object(v) &&
    keys(v, [
      "usedPercent",
      "remainingPercent",
      "windowDurationMins",
      "resetsAt",
    ]) &&
    percent(v.usedPercent) &&
    percent(v.remainingPercent) &&
    nullableIso(v.resetsAt) &&
    (v.windowDurationMins === null ||
      (typeof v.windowDurationMins === "number" &&
        Number.isFinite(v.windowDurationMins) &&
        v.windowDurationMins > 0 &&
        v.windowDurationMins <= 525600))
  );
}
export function isCloudSnapshot(v: unknown): v is CloudSnapshot {
  if (
    !object(v) ||
    !keys(v, [
      "schemaVersion",
      "deviceId",
      "sequence",
      "accountRef",
      "collectedAt",
      "attemptedAt",
      "provider",
      "refreshInterval",
      "status",
      "errorCode",
      "buckets",
    ])
  )
    return false;
  if (
    v.schemaVersion !== 1 ||
    !text(v.deviceId, 64) ||
    !Number.isSafeInteger(v.sequence) ||
    Number(v.sequence) < 1 ||
    !(
      v.accountRef === null ||
      (typeof v.accountRef === "string" && /^[a-f0-9]{64}$/.test(v.accountRef))
    ) ||
    !nullableIso(v.collectedAt) ||
    !iso(v.attemptedAt) ||
    !["app-server", "http", null].includes(v.provider as string | null) ||
    !Number.isInteger(v.refreshInterval) ||
    !(
      v.refreshInterval === 0 ||
      (Number(v.refreshInterval) >= 60 && Number(v.refreshInterval) <= 86400)
    ) ||
    !["ok", "error", "identity_unknown"].includes(String(v.status)) ||
    !(
      v.errorCode === null ||
      cloudErrorCodes.includes(v.errorCode as CloudErrorCode)
    ) ||
    !Array.isArray(v.buckets) ||
    v.buckets.length > 32
  )
    return false;
  if (
    !v.buckets.every(
      (b) =>
        object(b) &&
        keys(b, ["id", "name", "primary", "secondary"]) &&
        text(b.id, 160) &&
        text(b.name, 160) &&
        validWindow(b.primary) &&
        validWindow(b.secondary),
    )
  )
    return false;
  if (new Set(v.buckets.map((b) => b.id)).size !== v.buckets.length)
    return false;
  if (v.status === "identity_unknown")
    return (
      v.accountRef === null &&
      v.collectedAt === null &&
      v.buckets.length === 0 &&
      v.provider === null
    );
  if (v.accountRef === null) return false;
  if (v.status === "ok")
    return (
      v.collectedAt !== null && v.provider !== null && v.errorCode === null
    );
  return (
    v.errorCode !== null && (v.collectedAt !== null || v.buckets.length === 0)
  );
}

export function cloudStatusText(code: string | null): string {
  if (!code) return "";
  if (
    [
      "LOGIN_EXPIRED",
      "UNSUPPORTED_LOGIN",
      "CREDENTIALS_MISSING",
      "CREDENTIALS_INVALID",
    ].includes(code)
  )
    return "请在采集电脑上检查 Codex 登录，再刷新额度。";
  if (["IDENTITY_UNKNOWN", "IDENTITY_CHANGED"].includes(code))
    return "采集账户尚未确认，等待本机重新读取。";
  return "本机暂未取得新额度，正在显示最后成功采集的结果。";
}
