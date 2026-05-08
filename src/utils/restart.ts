/**
 * Restart notice helpers — portable env-based signaling across process restarts.
 *
 * Port of original Python utils/restart.py. Uses environment variables to pass
 * restart context (channel, chat_id, started_at) to the next process.
 */

const RESTART_NOTIFY_CHANNEL_ENV = '_JARVIS_RESTART_CHANNEL'
const RESTART_NOTIFY_CHAT_ID_ENV = '_JARVIS_RESTART_CHAT_ID'
const RESTART_STARTED_AT_ENV = '_JARVIS_RESTART_STARTED_AT'

export interface RestartNotice {
  channel: string
  chatId: string
  startedAtRaw: string
}

export function formatRestartCompletedMessage(startedAtRaw: string): string {
  let elapsedSuffix = ''
  if (startedAtRaw) {
    const elapsedS = Math.max(0, Date.now() / 1000 - parseFloat(startedAtRaw))
    if (isFinite(elapsedS)) {
      elapsedSuffix = ` in ${elapsedS.toFixed(1)}s`
    }
  }
  return `Restart completed${elapsedSuffix}.`
}

export function setRestartNoticeToEnv(channel: string, chatId: string): void {
  process.env[RESTART_NOTIFY_CHANNEL_ENV] = channel
  process.env[RESTART_NOTIFY_CHAT_ID_ENV] = chatId
  process.env[RESTART_STARTED_AT_ENV] = String(Date.now() / 1000)
}

export function consumeRestartNoticeFromEnv(): RestartNotice | null {
  const channel = (process.env[RESTART_NOTIFY_CHANNEL_ENV] ?? '').trim()
  const chatId = (process.env[RESTART_NOTIFY_CHAT_ID_ENV] ?? '').trim()
  const startedAtRaw = (process.env[RESTART_STARTED_AT_ENV] ?? '').trim()
  delete process.env[RESTART_NOTIFY_CHANNEL_ENV]
  delete process.env[RESTART_NOTIFY_CHAT_ID_ENV]
  delete process.env[RESTART_STARTED_AT_ENV]
  if (!channel || !chatId) return null
  return { channel, chatId, startedAtRaw }
}

export function shouldShowCliRestartNotice(notice: RestartNotice, sessionId: string): boolean {
  if (notice.channel !== 'cli') return false
  const cliChatId = sessionId.includes(':') ? sessionId.split(':', 2)[1]! : sessionId
  return !notice.chatId || notice.chatId === cliChatId
}

/** Legacy boolean-only helpers (backwards compat) */
export function setRestartNotice(): void {
  process.env._JARVIS_RESTART = '1'
}

export function consumeRestartNotice(): boolean {
  const r = process.env._JARVIS_RESTART === '1'
  delete process.env._JARVIS_RESTART
  return r
}
