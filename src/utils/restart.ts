/** 进程重启标志 */
export function setRestartNotice() { process.env._JARVIS_RESTART = '1' }
export function consumeRestartNotice(): boolean {
  const r = process.env._JARVIS_RESTART === '1'
  delete process.env._JARVIS_RESTART
  return r
}
