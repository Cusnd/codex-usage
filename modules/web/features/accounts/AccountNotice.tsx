import type { AccountStatus } from '../../../contracts/status.js';
import { time } from "../../widgets/ui.js";
import { MotionDetails } from "../../motion/MotionPrimitives.js";

export function AccountNotice({
  state,
  label,
  timezone,
  compact = false,
}: {
  state: AccountStatus | undefined;
  label: string;
  timezone: string;
  compact?: boolean;
}) {
  return (
    <div
      className={`notice account-notice${state?.error ? " is-error" : !state?.available || state.stale || !state.identityConfirmed ? " is-warning" : ""}`}
      role="status"
      aria-label={`${label}状态`}
    >
      <strong>
        {label}：
        {state?.running
          ? "正在更新"
          : state?.error
            ? "更新失败"
            : state?.available
              ? "已读取"
              : "尚未取得数据"}
      </strong>
      <MotionDetails
        className="account-source-details"
        defaultOpen={!compact}
        summary="来源与更新时间"
      >
        {state?.provider && (
          <span>
            {state.provider === "http" ? "OAuth / HTTP" : "Codex App Server"}
          </span>
        )}
        {state?.accountId && (
          <p>
            账户：<code>{state.accountId}</code>
          </p>
        )}
        <p>最近成功：{time(state?.updatedAt, timezone)}</p>
      </MotionDetails>
      {state?.available && (state.stale || !state.identityConfirmed) && (
        <p>历史快照，不能视为当前账户的实时状态。</p>
      )}
      {state?.error && <p>{state.error}</p>}
      {state?.fallbackReason && (
        <p>
          {state.stale
            ? "上次成功读取使用 OAuth；本次结果仍为历史快照。"
            : "未检测到 Codex CLI，已使用现有 OAuth 登录读取额度。"}
        </p>
      )}
      {!state?.identityConfirmed && (
        <p>当前身份尚未确认；已有旧记录仍保留在本机。</p>
      )}
    </div>
  );
}
