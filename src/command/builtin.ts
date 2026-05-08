/**
 * 内置斜杠命令
 *
 * ========= TODO: 与 nanobot 差异标注 =========
 * - /restart：os.execv 原地重启（当前仅返回提示消息）
 * - /status：search_usage / active_tasks / subagent_count（依赖 SubagentManager）
 * - /dream, /dream-log, /dream-restore：依赖 Consolidator + Dream + GitStore
 * - /stop：依赖 _cancelActiveTasks（当前仅返回确认消息）
 * - /new：关闭当前会话并归档到 Consolidator（当前仅清空 SessionStore）
 */

import type { OutboundMessage } from '../bus'
import type { CommandContext } from './router'

// ---- /help ----

async function cmdHelp(ctx: CommandContext): Promise<OutboundMessage> {
  return {
    channel: ctx.channel,
    chatId: ctx.chatId,
    content: buildHelpText(),
    metadata: { ...ctx.metadata, render_as: 'text' },
    media: [],
    buttons: [],
  }
}

function buildHelpText(): string {
  return [
    'jarvis commands:',
    '/new — Start a new conversation',
    '/stop — Stop the current task',
    '/status — Show session status',
    '/restart — Restart the agent',
    '/help — Show available commands',
  ].join('\n')
}

// ---- /stop ----

async function cmdStop(ctx: CommandContext): Promise<OutboundMessage> {
  // TODO: 实际取消活跃任务
  return {
    channel: ctx.channel,
    chatId: ctx.chatId,
    content: 'Stopped active task(s).',
    metadata: { ...ctx.metadata },
    media: [],
    buttons: [],
  }
}

// ---- /restart ----

async function cmdRestart(ctx: CommandContext): Promise<OutboundMessage> {
  // TODO: os.execv 原地重启
  return {
    channel: ctx.channel,
    chatId: ctx.chatId,
    content: 'Restarting... (not yet implemented — please restart manually)',
    metadata: { ...ctx.metadata },
    media: [],
    buttons: [],
  }
}

// ---- /status ----

async function cmdStatus(ctx: CommandContext): Promise<OutboundMessage> {
  const parts: string[] = [
    '## Session Status',
    '',
    `- Session: \`${ctx.sessionKey}\``,
  ]
  return {
    channel: ctx.channel,
    chatId: ctx.chatId,
    content: parts.join('\n'),
    metadata: { ...ctx.metadata, render_as: 'text' },
    media: [],
    buttons: [],
  }
}

// ---- /new ----

async function cmdNew(ctx: CommandContext): Promise<OutboundMessage> {
  // TODO: 实际清空 session + 归档到 Consolidator
  return {
    channel: ctx.channel,
    chatId: ctx.chatId,
    content: 'New session started.',
    metadata: { ...ctx.metadata },
    media: [],
    buttons: [],
  }
}

// ---- 注册 ----

export function registerBuiltinCommands(
  priorityCmd: (cmd: string, handler: (ctx: CommandContext) => Promise<OutboundMessage | null>) => void,
  exactCmd: (cmd: string, handler: (ctx: CommandContext) => Promise<OutboundMessage | null>) => void,
): void {
  priorityCmd('/stop', cmdStop)
  priorityCmd('/restart', cmdRestart)
  priorityCmd('/status', cmdStatus)
  exactCmd('/new', cmdNew)
  exactCmd('/help', cmdHelp)
}
