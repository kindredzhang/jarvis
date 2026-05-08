/**
 * 内置斜杠命令
 */
import type { OutboundMessage } from '../bus'
import type { CommandContext } from './router'

// ---- /help ----

async function cmdHelp(ctx: CommandContext): Promise<OutboundMessage> {
  return { channel: ctx.channel, chatId: ctx.chatId, content: buildHelpText(), metadata: { ...ctx.metadata, render_as: 'text' }, media: [], buttons: [] }
}

function buildHelpText(): string {
  return [
    'jarvis commands:',
    '/help — Show this help',
    '/new — Start a new conversation (clears history)',
    '/stop — Stop running tasks',
    '/status — Show session stats',
    '/dream — Trigger memory consolidation',
    '/dream-log — Show latest Dream changes',
    '/dream-restore <sha> — Restore memory to previous version',
    '/restart — Restart the agent process',
  ].join('\n')
}

// ---- /stop ----

async function cmdStop(ctx: CommandContext): Promise<OutboundMessage> {
  const loop = ctx.loop
  if (loop?.subagents) {
    const count = await loop.subagents.cancelBySession(ctx.sessionKey)
    return { channel: ctx.channel, chatId: ctx.chatId, content: `Stopped ${count} task(s).`, metadata: { ...ctx.metadata }, media: [], buttons: [] }
  }
  return { channel: ctx.channel, chatId: ctx.chatId, content: 'Stopped active task(s).', metadata: { ...ctx.metadata }, media: [], buttons: [] }
}

// ---- /restart ----

async function cmdRestart(_ctx: CommandContext): Promise<OutboundMessage> {
  // TODO: os.execv equivalent - restart via process exit
  process.exit(0)
}

// ---- /status ----

async function cmdStatus(ctx: CommandContext): Promise<OutboundMessage> {
  const parts = [`## Session: \`${ctx.sessionKey}\``]
  const loop = ctx.loop
  if (loop?.sessions) {
    const history = loop.sessions.getHistory(ctx.sessionKey)
    parts.push(`- Messages: ${history.length}`)
  }
  if (loop?.memory?.git?.isInitialized()) {
    const commits = loop.memory.git.log(5)
    if (commits.length > 0) parts.push(`- Git commits: ${commits.length} (latest: ${commits[0].sha})`)
  }
  parts.push(`- Subagent tasks running: ${loop?.subagents?.getRunningCount?.() ?? 0}`)
  return { channel: ctx.channel, chatId: ctx.chatId, content: parts.join('\n'), metadata: { ...ctx.metadata, render_as: 'text' }, media: [], buttons: [] }
}

// ---- /new ----

async function cmdNew(ctx: CommandContext): Promise<OutboundMessage> {
  // Clear session history
  const loop = ctx.loop
  if (loop?.sessions) {
    const session = loop.sessions.getOrCreate(ctx.sessionKey)
    session.splice(0, session.length)
    loop.sessions.save(ctx.sessionKey)
  }
  return { channel: ctx.channel, chatId: ctx.chatId, content: 'Session cleared. Starting fresh.', metadata: { ...ctx.metadata }, media: [], buttons: [] }
}

// ---- /dream ----

async function cmdDream(ctx: CommandContext): Promise<OutboundMessage> {
  const loop = ctx.loop
  if (loop?.dream) {
    loop.dream.run().then((didWork: boolean) => console.log(`[Dream] ${didWork ? 'completed' : 'nothing to process'}`)).catch((err: Error) => console.error(`[Dream] failed: ${err}`))
    return { channel: ctx.channel, chatId: ctx.chatId, content: 'Dreaming...', metadata: { ...ctx.metadata }, media: [], buttons: [] }
  }
  return { channel: ctx.channel, chatId: ctx.chatId, content: 'Dream not available.', metadata: { ...ctx.metadata }, media: [], buttons: [] }
}

// ---- /dream-log ----

async function cmdDreamLog(ctx: CommandContext): Promise<OutboundMessage> {
  const loop = ctx.loop
  if (!loop?.memory?.git?.isInitialized()) {
    return { channel: ctx.channel, chatId: ctx.chatId, content: 'Dream history not available (git not initialized).', metadata: { ...ctx.metadata, render_as: 'text' }, media: [], buttons: [] }
  }
  const args = ctx.args.trim()
  if (args) {
    const result = loop.memory.git.showCommitDiff(args)
    if (!result) return { channel: ctx.channel, chatId: ctx.chatId, content: `Commit '${args}' not found.`, metadata: { ...ctx.metadata }, media: [], buttons: [] }
    const [info, diff] = result
    const content = `## ${info.message}\n\`${info.sha}\` — ${info.timestamp}\n\n\`\`\`diff\n${diff}\n\`\`\``
    return { channel: ctx.channel, chatId: ctx.chatId, content, metadata: { ...ctx.metadata, render_as: 'text' }, media: [], buttons: [] }
  }
  const commits = loop.memory.git.log(5)
  if (commits.length === 0) return { channel: ctx.channel, chatId: ctx.chatId, content: 'No Dream commits yet.', metadata: { ...ctx.metadata }, media: [], buttons: [] }
  const content = ['## Dream History\n'].concat(commits.map((c: any) => `- \`${c.sha}\` ${c.timestamp} — ${c.message.split('\n')[0]}`)).join('\n')
  return { channel: ctx.channel, chatId: ctx.chatId, content, metadata: { ...ctx.metadata, render_as: 'text' }, media: [], buttons: [] }
}

// ---- /dream-restore ----

async function cmdDreamRestore(ctx: CommandContext): Promise<OutboundMessage> {
  const loop = ctx.loop
  if (!loop?.memory?.git?.isInitialized()) {
    return { channel: ctx.channel, chatId: ctx.chatId, content: 'Dream restore not available (git not initialized).', metadata: { ...ctx.metadata }, media: [], buttons: [] }
  }
  const args = ctx.args.trim()
  if (!args) {
    const commits = loop.memory.git.log(10)
    if (commits.length === 0) return { channel: ctx.channel, chatId: ctx.chatId, content: 'No versions to restore.', metadata: { ...ctx.metadata }, media: [], buttons: [] }
    const content = ['Available versions (latest first):\n'].concat(commits.map((c: any) => `- \`${c.sha}\` ${c.timestamp} — ${c.message.split('\n')[0]}`)).join('\n') + '\n\nUse /dream-restore <sha> to revert.'
    return { channel: ctx.channel, chatId: ctx.chatId, content, metadata: { ...ctx.metadata, render_as: 'text' }, media: [], buttons: [] }
  }
  const newSha = loop.memory.git.revert(args)
  if (newSha) return { channel: ctx.channel, chatId: ctx.chatId, content: `Restored to state before \`${args}\`. New commit: \`${newSha}\`.`, metadata: { ...ctx.metadata }, media: [], buttons: [] }
  return { channel: ctx.channel, chatId: ctx.chatId, content: `Could not restore \`${args}\`.`, metadata: { ...ctx.metadata }, media: [], buttons: [] }
}

// ---- 注册 ----

export function registerBuiltinCommands(
  priorityCmd: (cmd: string, handler: (ctx: CommandContext) => Promise<OutboundMessage | null>) => void,
  exactCmd: (cmd: string, handler: (ctx: CommandContext) => Promise<OutboundMessage | null>) => void,
  prefixCmd?: (cmd: string, handler: (ctx: CommandContext) => Promise<OutboundMessage | null>) => void,
): void {
  priorityCmd('/stop', cmdStop)
  priorityCmd('/restart', cmdRestart)
  priorityCmd('/status', cmdStatus)
  exactCmd('/new', cmdNew)
  exactCmd('/help', cmdHelp)
  exactCmd('/dream', cmdDream)
  exactCmd('/dream-log', cmdDreamLog)
  exactCmd('/dream-restore', cmdDreamRestore)
  // Prefix variants for args
  if (prefixCmd) {
    prefixCmd('/dream-log ', cmdDreamLog)
    prefixCmd('/dream-restore ', cmdDreamRestore)
  }
}
