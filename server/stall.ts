// ===== 上游停滞保护 =====
// 两种等待分开计时，避免把"本地模型正常预填充"误判成卡死：
// - prefill（响应头/首包之前）：本地模型几十万 token 的预填充可能持续几分钟甚至更久，
//   OpenAI SDK 的 10 分钟 timeout 只覆盖到响应头，流式 body 阶段不受它保护，必须自己兜底；
// - idle（首包之后）：生成中途完全无输出，基本可以判定上游卡死（120 秒）。
// 两者都有上界，所以任何情况下都不会无限期卡住会话。
export const STALL_PREFILL_MS = 600_000
export const STALL_IDLE_MS = 120_000

export interface StallGuard {
  signal: AbortSignal // 传给上游请求（用户停止 / 停滞都会 abort）
  arm(): void // 发起请求前调用；之后每收到一个 chunk 再调用（重新计时）
  markChunk(): void // 收到任意 chunk（含首包）后切换到 idle 计时
  stalled(): boolean
  reason(): string // 停滞时给用户/日志的说明
  dispose(): void
}

export function stallGuard(
  userSignal: AbortSignal,
  opts: { prefillMs?: number; idleMs?: number } = {},
): StallGuard {
  const prefillMs = opts.prefillMs ?? STALL_PREFILL_MS
  const idleMs = opts.idleMs ?? STALL_IDLE_MS
  const ctl = new AbortController()
  const onUserAbort = () => ctl.abort()
  userSignal.addEventListener('abort', onUserAbort, { once: true })
  let timer: NodeJS.Timeout | undefined
  let stalled = false
  let gotChunk = false
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      stalled = true
      ctl.abort()
    }, gotChunk ? idleMs : prefillMs)
  }
  return {
    signal: ctl.signal,
    arm,
    markChunk() {
      gotChunk = true
    },
    stalled: () => stalled,
    reason: () =>
      gotChunk
        ? `上游生成停滞（${idleMs / 1000} 秒无输出），已中止`
        : `上游生成停滞（${prefillMs / 1000} 秒未收到首个数据包），已中止`,
    dispose() {
      clearTimeout(timer)
      userSignal.removeEventListener('abort', onUserAbort)
    },
  }
}
