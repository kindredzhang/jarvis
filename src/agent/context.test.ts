import { test, expect, beforeEach, afterEach } from 'bun:test'
import { ContextBuilder } from './context'
import { MemoryStore } from './memory'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { currentTimeStr, buildAssistantMessage } from '../utils/helpers'

let workspace: string
let memory: MemoryStore
let ctx: ContextBuilder

beforeEach(() => {
  workspace = join(tmpdir(), 'jarvis-ctx-' + Math.random().toString(36).slice(2, 8))
  if (existsSync(workspace)) rmSync(workspace, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  memory = new MemoryStore(workspace, 100)
  ctx = new ContextBuilder({ workspace, memory })
})

afterEach(() => {
  if (existsSync(workspace)) rmSync(workspace, { recursive: true })
})

// ============ 系统提示词 ============

test('buildSystemPrompt with identity only', () => {
  const prompt = ctx.buildSystemPrompt({ identity: '你是一个助手' })
  expect(prompt).toContain('你是一个助手')
  // 内置 memory skill 应自动加载
  expect(prompt).toContain('Active Skills')
  expect(prompt).toContain('memory')
})

test('buildSystemPrompt includes bootstrap files', () => {
  writeFileSync(join(workspace, 'SOUL.md'), '# 我是一个友善的AI')
  writeFileSync(join(workspace, 'USER.md'), '# 用户偏好：中文')

  const prompt = ctx.buildSystemPrompt({ identity: 'Identity' })
  expect(prompt).toContain('## SOUL.md')
  expect(prompt).toContain('我是一个友善的AI')
  expect(prompt).toContain('## USER.md')
  expect(prompt).toContain('用户偏好：中文')
})

test('buildSystemPrompt includes memory', () => {
  memory.writeMemory('重要：用户叫 Alice')
  const prompt = ctx.buildSystemPrompt()
  expect(prompt).toContain('# Memory')
  expect(prompt).toContain('用户叫 Alice')
})

test('buildSystemPrompt includes recent history', () => {
  memory.setLastDreamCursor(0)
  memory.appendHistory('用户问过天气')
  memory.appendHistory('用户问过日程')

  const prompt = ctx.buildSystemPrompt()
  expect(prompt).toContain('# Recent History')
  expect(prompt).toContain('用户问过天气')
  expect(prompt).toContain('用户问过日程')
})

test('buildSystemPrompt sections separated by ---', () => {
  writeFileSync(join(workspace, 'SOUL.md'), 'soul')
  memory.writeMemory('memory')
  memory.setLastDreamCursor(0)
  memory.appendHistory('history')

  const prompt = ctx.buildSystemPrompt({ identity: 'id' })
  const sections = prompt.split('\n\n---\n\n')
  expect(sections.length).toBeGreaterThanOrEqual(3)
})

// ============ 运行时上下文 ============

test('buildRuntimeContext includes current time', () => {
  const ctx = ContextBuilder.buildRuntimeContext('feishu', 'chat_1', 'Asia/Shanghai')
  expect(ctx).toContain('Current Time:')
  expect(ctx).toContain('[/Runtime Context]')
  expect(ctx).toContain('Channel: feishu')
  expect(ctx).toContain('Chat ID: chat_1')
})

test('buildRuntimeContext without channel produces no channel lines', () => {
  const ctx = ContextBuilder.buildRuntimeContext(null, null)
  expect(ctx).not.toContain('Channel:')
  expect(ctx).not.toContain('Chat ID:')
})

test('buildRuntimeContext with session summary', () => {
  const ctx = ContextBuilder.buildRuntimeContext('dc', 'c1', undefined, 'Previously user asked about X')
  expect(ctx).toContain('[Resumed Session]')
  expect(ctx).toContain('Previously user asked about X')
})

// ============ 消息列表构建 ============

test('buildMessages creates system and user messages', () => {
  const msgs = ctx.buildMessages({
    history: [],
    currentMessage: '你好',
    channel: 'feishu',
    chatId: 'chat_1',
  })

  expect(msgs).toHaveLength(2)
  expect(msgs[0].role).toBe('system')
  expect(msgs[1].role).toBe('user')
  expect(msgs[1].content).toContain('你好')
  expect(msgs[1].content).toContain('[Runtime Context')
})

test('buildMessages includes history', () => {
  const history = [
    { role: 'user', content: '之前的问题' },
    { role: 'assistant', content: '之前的回答' },
  ]

  const msgs = ctx.buildMessages({
    history,
    currentMessage: '新问题',
    channel: 'slack',
    chatId: 'c2',
  })

  expect(msgs).toHaveLength(4)
  expect(msgs[0].role).toBe('system')
  expect(msgs[1].role).toBe('user')
  expect(msgs[1].content).toBe('之前的问题')
  expect(msgs[2].content).toBe('之前的回答')
})

test('buildMessages merges consecutive same-role messages', () => {
  const history = [
    { role: 'user', content: 'continuation' },
  ]

  const msgs = ctx.buildMessages({
    history,
    currentMessage: 'hello',
    currentRole: 'user',
  })

  // 应该合并到 history 的最后一条 user 消息
  expect(msgs).toHaveLength(2)
  expect(msgs[1].role).toBe('user')
  expect(msgs[1].content).toContain('continuation')
  expect(msgs[1].content).toContain('hello')
})

// ============ 消息内容合并 ============

test('mergeMessageContent merges two strings', () => {
  const result = ContextBuilder.mergeMessageContent('hello', 'world')
  expect(result).toBe('hello\n\nworld')
})

test('mergeMessageContent handles empty left string', () => {
  const result = ContextBuilder.mergeMessageContent('', 'world')
  expect(result).toBe('world')
})

test('mergeMessageContent merges content blocks', () => {
  const left = [{ type: 'text', text: 'left text' }]
  const right = [{ type: 'text', text: 'right text' }]
  const result = ContextBuilder.mergeMessageContent(left, right) as Record<string, unknown>[]
  expect(result).toHaveLength(2)
  expect(result[0].text).toBe('left text')
  expect(result[1].text).toBe('right text')
})

// ============ 工具结果 ============

test('addToolResult appends to messages', () => {
  const msgs: Record<string, unknown>[] = [
    { role: 'user', content: 'read file' },
  ]
  ctx.addToolResult(msgs, 'call_1', 'read_file', 'file contents')

  expect(msgs).toHaveLength(2)
  expect(msgs[1].role).toBe('tool')
  expect(msgs[1].tool_call_id).toBe('call_1')
  expect(msgs[1].name).toBe('read_file')
  expect(msgs[1].content).toBe('file contents')
})

// ============ assistant 消息 ============

test('addAssistantMessage appends to messages', () => {
  const msgs: Record<string, unknown>[] = []
  ctx.addAssistantMessage(msgs, '响应内容')

  expect(msgs).toHaveLength(1)
  expect(msgs[0].role).toBe('assistant')
  expect(msgs[0].content).toBe('响应内容')
})

test('addAssistantMessage with tool calls', () => {
  const msgs: Record<string, unknown>[] = []
  ctx.addAssistantMessage(msgs, null, {
    toolCalls: [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'greet', arguments: '{"name":"Alice"}' },
      },
    ],
  })

  const msg = msgs[0]
  expect(msg.role).toBe('assistant')
  expect(msg.tool_calls).toBeDefined()
  expect((msg.tool_calls as Record<string, unknown>[])).toHaveLength(1)
})

test('addAssistantMessage with reasoning content', () => {
  const msgs: Record<string, unknown>[] = []
  ctx.addAssistantMessage(msgs, 'final answer', {
    reasoningContent: 'step by step reasoning',
  })

  expect(msgs[0].reasoning_content).toBe('step by step reasoning')
})

// ============ buildAssistantMessage helper ============

test('buildAssistantMessage basic', () => {
  const msg = buildAssistantMessage('hello')
  expect(msg.role).toBe('assistant')
  expect(msg.content).toBe('hello')
})

test('buildAssistantMessage null content becomes empty string', () => {
  const msg = buildAssistantMessage(null)
  expect(msg.content).toBe('')
})

// ============ currentTimeStr ============

test('currentTimeStr returns formatted time', () => {
  const time = currentTimeStr('Asia/Shanghai')
  expect(time).toContain('2026')
  expect(time).toContain('UTC')
  expect(time).toContain('Asia/Shanghai')
})

// ============ 引导文件 ============

test('bootstrap files only include existing files', () => {
  writeFileSync(join(workspace, 'SOUL.md'), '# Soul')
  // AGENTS.md, USER.md, TOOLS.md 不存在

  const prompt = ctx.buildSystemPrompt()
  expect(prompt).toContain('Soul')
  expect(prompt).not.toContain('TOOLS.md')
})
