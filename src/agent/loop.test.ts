import { test, expect, describe } from 'bun:test'
import { AgentLoop } from './loop'
import { Tool, defineParams } from './tools/base'
import { LLMProvider } from '../providers/base'
import type { Message, LLMResponse, ToolDefinition } from '../providers/types'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { InboundMessage } from '../bus'

// ---- Mock Provider ----

class MockProvider extends LLMProvider {
  readonly model = 'mock-model'
  private responses: LLMResponse[] = []
  private callIndex = 0

  constructor(responses: LLMResponse[]) {
    super()
    this.responses = responses
  }

  async generate(
    messages: Message[],
    options?: { tools?: ToolDefinition[]; settings?: unknown },
  ): Promise<LLMResponse> {
    const response = this.responses[this.callIndex] ?? {
      content: 'mock default',
      finishReason: 'stop',
      toolCalls: [],
    }
    this.callIndex++
    return response
  }

  async *generateStream(
    messages: Message[],
    options?: { tools?: ToolDefinition[]; settings?: unknown },
  ): AsyncIterable<import('../providers/types').LLMResponseChunk> {
    yield { content: 'mock', finishReason: 'stop', toolCalls: [] }
  }
}

// ---- Mock Tool ----

class GreetTool extends Tool {
  readonly name = 'greet'
  readonly description = 'say hello'
  readonly parameters = defineParams({
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  })
  async execute(args: Record<string, unknown>): Promise<string> {
    return 'Hello, ' + args.name + '!'
  }
}

class LongTool extends Tool {
  readonly name = 'longtool'
  readonly description = 'returns long result'
  readonly parameters = defineParams({ type: 'object', properties: {} })
  async execute(): Promise<string> { return 'A'.repeat(2000) }
}

// ---- Helper ----

function createLoop(responses: LLMResponse[]): AgentLoop {
  const provider = new MockProvider(responses)
  return new AgentLoop({
    provider,
    workspace: mkdtempSync(join(tmpdir(), 'jarvis-test-')),
    model: 'mock-model',
    maxIterations: 5,
    maxToolResultChars: 1000,
  })
}

// ============ processDirect ============

describe('AgentLoop.processDirect', () => {
  test('returns simple text response', async () => {
    const loop = createLoop([
      { content: 'Hello!', finishReason: 'stop', toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    ])

    const result = await loop.processDirect('hi')
    expect(result).not.toBeNull()
    expect(result!.content).toBe('Hello!')
    expect(result!.channel).toBe('cli')
    expect(result!.chatId).toBe('direct')
  })

  test('executes tool call and returns result', async () => {
    const loop = createLoop([
      {
        content: null,
        finishReason: 'tool_calls',
        toolCalls: [
          { id: 'call_1', type: 'function', function: { name: 'greet', arguments: '{"name":"Alice"}' } },
        ],
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      },
      {
        content: 'Greeted Alice!',
        finishReason: 'stop',
        toolCalls: [],
        usage: { promptTokens: 30, completionTokens: 5, totalTokens: 35 },
      },
    ])
    loop.tools.register(new GreetTool())

    const result = await loop.processDirect('greet Alice')
    expect(result).not.toBeNull()
    expect(result!.content).toContain('Greeted')
  })

  test('empty response returns error content', async () => {
    const loop = createLoop([
      { content: '', finishReason: 'stop', toolCalls: [], usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 } },
    ])

    const result = await loop.processDirect('say something')
    // AgentRunner treats empty response as error with default message
    expect(result).not.toBeNull()
    expect(result!.content).toContain('Empty response')
  })

  test('saves session history to SessionStore', async () => {
    const loop = createLoop([
      { content: 'Hello!', finishReason: 'stop', toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    ])

    await loop.processDirect('hi', { sessionKey: 'test-session' })

    const history = loop.sessions.getHistory('test-session')
    const assistantMsgs = history.filter(m => m.role === 'assistant')
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1)
  })

  test('multi-turn preserves history', async () => {
    const loop = createLoop([
      { content: 'First reply', finishReason: 'stop', toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
      { content: 'Second reply', finishReason: 'stop', toolCalls: [], usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 } },
    ])

    await loop.processDirect('hello', { sessionKey: 'multi-turn' })
    await loop.processDirect('continue', { sessionKey: 'multi-turn' })

    const history = loop.sessions.getHistory('multi-turn')
    const assistantMsgs = history.filter(m => m.role === 'assistant')
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(2)
  })

  test('custom channel and chatId', async () => {
    const loop = createLoop([
      { content: 'OK', finishReason: 'stop', toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    ])

    const result = await loop.processDirect('hi', { channel: 'feishu', chatId: '12345' })
    expect(result).not.toBeNull()
    expect(result!.channel).toBe('feishu')
    expect(result!.chatId).toBe('12345')
  })
})

// ============ processMessage ============

describe('AgentLoop.processMessage', () => {
  test('processes InboundMessage and returns OutboundMessage', async () => {
    const loop = createLoop([
      { content: 'Reply here', finishReason: 'stop', toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    ])

    const msg = new InboundMessage({
      channel: 'test',
      senderId: 'user1',
      chatId: 'chat1',
      content: 'hello',
    })

    const result = await loop.processMessage(msg, undefined, 'test:chat1')
    expect(result).not.toBeNull()
    expect(result!.content).toContain('Reply')
    expect(result!.channel).toBe('test')
    expect(result!.chatId).toBe('chat1')
  })
})

// ============ stripThink ============

describe('AgentLoop.stripThink', () => {
  test('strips think tags', () => {
    const openTag = String.fromCharCode(60) + "think>"; const closeTag = String.fromCharCode(60) + "/think>"; const input = "Let me " + openTag + "thinking" + closeTag + " The answer is 42."
    const result = AgentLoop.stripThink(input)
    expect(result).not.toBeNull()
    expect(result).toContain("The answer is 42")
  })

  test('null input returns null', () => {
    expect(AgentLoop.stripThink(null)).toBeNull()
    expect(AgentLoop.stripThink(undefined)).toBeNull()
    expect(AgentLoop.stripThink('')).toBeNull()
  })

  test('plain text returned as-is', () => {
    expect(AgentLoop.stripThink('hello world')).toBe('hello world')
  })
})

// ============ config ============

describe('AgentLoop config', () => {
  test('default config', () => {
    const provider = new MockProvider([])
    const loop = new AgentLoop({
      provider,
      workspace: mkdtempSync(join(tmpdir(), 'jarvis-cfg1-')),
    })

    expect(loop.model).toBe('mock-model')
    expect(loop.maxIterations).toBe(15)
    expect(loop.maxToolResultChars).toBe(60_000)
  })

  test('custom config', () => {
    const provider = new MockProvider([])
    const loop = new AgentLoop({
      provider,
      workspace: mkdtempSync(join(tmpdir(), 'jarvis-cfg2-')),
      model: 'deepseek-chat',
      maxIterations: 10,
      maxToolResultChars: 30_000,
      timezone: 'Asia/Shanghai',
    })

    expect(loop.model).toBe('deepseek-chat')
    expect(loop.maxIterations).toBe(10)
    expect(loop.maxToolResultChars).toBe(30_000)
  })

  test('subsystems initialized', () => {
    const provider = new MockProvider([])
    const loop = new AgentLoop({ provider, workspace: mkdtempSync(join(tmpdir(), 'jarvis-cfg3-')) })

    expect(loop.memory).toBeDefined()
    expect(loop.context).toBeDefined()
    expect(loop.sessions).toBeDefined()
    expect(loop.tools).toBeDefined()
    expect(loop.runner).toBeDefined()
  })
})
