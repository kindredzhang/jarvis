import { test, expect } from 'bun:test'
import { AgentRunner, type AgentRunSpec, type AgentRunResult } from './runner'
import { ToolRegistry } from './tools/registry'
import { Tool, defineParams } from './tools/base'
import { LLMProvider } from '../providers/base'
import type { Message, LLMResponse, ToolCallRequest } from '../providers/types'

// ---- 测试用 Provider（Mock） ----

class MockProvider extends LLMProvider {
  readonly model = 'mock-model'

  private responses: LLMResponse[] = []
  private callCount = 0

  constructor(responses: LLMResponse[]) {
    super()
    this.responses = responses
  }

  async generate(
    messages: Message[],
    options?: any,
  ): Promise<LLMResponse> {
    const response = this.responses[this.callCount] ?? {
      content: '[fallback]',
      finishReason: 'stop' as const,
      toolCalls: [],
    }
    this.callCount++
    return response
  }

  async *generateStream(
    messages: Message[],
    options?: any,
  ): AsyncIterable<import('../providers/types').LLMResponseChunk> {
    yield { content: 'mock', finishReason: 'stop', toolCalls: [] }
  }

  get callCountGetter() {
    return this.callCount
  }
}

// ---- 测试用工具 ----

class GreetTool extends Tool {
  readonly name = 'greet'
  readonly description = '打招呼'
  readonly parameters = defineParams({
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  })
  async execute(args: Record<string, unknown>): Promise<string> {
    return `Hello, ${args.name}!`
  }
}

class FailTool extends Tool {
  readonly name = 'fail_tool'
  readonly description = '总是失败的工具'
  readonly parameters = defineParams({ type: 'object', properties: {} })
  async execute(args: Record<string, unknown>): Promise<string> {
    throw new Error('intentional failure')
  }
}

// ---- 辅助函数 ----

function createSpec(overrides?: Partial<AgentRunSpec>): AgentRunSpec {
  const tools = new ToolRegistry()
  tools.register(new GreetTool())
  tools.register(new FailTool())

  return {
    initialMessages: [{ role: 'system', content: '你是助手' }],
    tools,
    model: 'mock-model',
    maxIterations: 5,
    maxToolResultChars: 1000,
    ...overrides,
  }
}

// ============ 基础运行 ============

test('run returns final content on first response', async () => {
  const provider = new MockProvider([
    { content: '你好，有什么可以帮你？', finishReason: 'stop', toolCalls: [], usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } },
  ])
  const runner = new AgentRunner(provider as any)
  const spec = createSpec()

  const result = await runner.run(spec)
  expect(result.finalContent).toBe('你好，有什么可以帮你？')
  expect(result.stopReason).toBe('completed')
  expect(result.toolsUsed).toEqual([])
  expect(result.usage.promptTokens).toBe(100)
})

test('run executes tools and continues', async () => {
  const provider = new MockProvider([
    {
      content: null,
      finishReason: 'tool_calls',
      toolCalls: [
        { id: 'call_1', type: 'function', function: { name: 'greet', arguments: '{"name":"Alice"}' } },
      ],
      usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 },
    },
    {
      content: '已经帮你打了招呼！',
      finishReason: 'stop',
      toolCalls: [],
      usage: { promptTokens: 150, completionTokens: 20, totalTokens: 170 },
    },
  ])
  const runner = new AgentRunner(provider as any)
  const spec = createSpec()

  const result = await runner.run(spec)
  expect(result.finalContent).toBe('已经帮你打了招呼！')
  expect(result.toolsUsed).toEqual(['greet'])
  expect(result.stopReason).toBe('completed')
  expect(result.messages).toHaveLength(4) // system + assistant(tool) + tool_result + final
})

test('run handles tool error with failOnToolError', async () => {
  const provider = new MockProvider([
    {
      content: null,
      finishReason: 'tool_calls',
      toolCalls: [
        { id: 'call_2', type: 'function', function: { name: 'fail_tool', arguments: '{}' } },
      ],
      usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
    },
  ])
  const runner = new AgentRunner(provider as any)
  const spec = createSpec({ failOnToolError: true })

  const result = await runner.run(spec)
  expect(result.stopReason).toBe('tool_error')
  expect(result.error).toContain('intentional failure')
})

test('run handles tool error gracefully when failOnToolError is false', async () => {
  const provider = new MockProvider([
    {
      content: null,
      finishReason: 'tool_calls',
      toolCalls: [
        { id: 'call_2', type: 'function', function: { name: 'fail_tool', arguments: '{}' } },
      ],
      usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
    },
    {
      content: '工具失败了，让我换个方式',
      finishReason: 'stop',
      toolCalls: [],
      usage: { promptTokens: 80, completionTokens: 20, totalTokens: 100 },
    },
  ])
  const runner = new AgentRunner(provider as any)
  const spec = createSpec({ failOnToolError: false })

  const result = await runner.run(spec)
  expect(result.stopReason).toBe('completed')
  expect(result.finalContent).toContain('换个方式')
})

test('run stops at max_iterations', async () => {
  const toolCallResponse: LLMResponse = {
    content: null,
    finishReason: 'tool_calls',
    toolCalls: [
      { id: 'c1', type: 'function', function: { name: 'greet', arguments: '{"name":"A"}' } },
    ],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  }
  // 永远返回 tool_calls，不会结束
  const responses = Array.from({ length: 10 }, () => toolCallResponse)
  const provider = new MockProvider(responses)
  const runner = new AgentRunner(provider as any)
  const spec = createSpec({ maxIterations: 3 })

  const result = await runner.run(spec)
  expect(result.stopReason).toBe('max_iterations')
})

test('run handles LLM error response', async () => {
  const provider = new MockProvider([
    { content: 'Model overloaded', finishReason: 'error', toolCalls: [], usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 } },
  ])
  const runner = new AgentRunner(provider as any)
  const spec = createSpec()

  const result = await runner.run(spec)
  expect(result.stopReason).toBe('error')
  expect(result.error).toBe('Model overloaded')
})

test('run handles empty response', async () => {
  const provider = new MockProvider([
    { content: '', finishReason: 'stop', toolCalls: [], usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 } },
  ])
  const runner = new AgentRunner(provider as any)
  const spec = createSpec()

  const result = await runner.run(spec)
  expect(result.stopReason).toBe('error')
  expect(result.error).toContain('Empty response')
})

// ============ 上下文治理 ============

test('dropOrphanToolResults removes orphan tool results', () => {
  const messages = [
    { role: 'system', content: 'test' },
    { role: 'tool', tool_call_id: 'orphan_1', name: 'test', content: 'orphan' },
    { role: 'user', content: 'hello' },
  ]
  const cleaned = AgentRunner.dropOrphanToolResults(messages)
  expect(cleaned).toHaveLength(2)
  expect(cleaned.some((m) => m.tool_call_id === 'orphan_1')).toBe(false)
})

test('dropOrphanToolResults keeps valid tool results', () => {
  const messages = [
    { role: 'system', content: 'test' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'g', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', name: 'g', content: 'result' },
  ]
  const cleaned = AgentRunner.dropOrphanToolResults(messages)
  expect(cleaned).toHaveLength(3)
})

test('backfillMissingToolResults inserts placeholders for missing results', () => {
  const messages = [
    { role: 'system', content: 'test' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'g', arguments: '{}' } },
      { id: 'call_2', type: 'function', function: { name: 'h', arguments: '{}' } },
    ]},
    { role: 'tool', tool_call_id: 'call_1', name: 'g', content: 'done' },
  ]
  const fixed = AgentRunner.backfillMissingToolResults(messages)
  expect(fixed).toHaveLength(4)
  const toolMsgs = fixed.filter((m) => m.role === 'tool')
  expect(toolMsgs).toHaveLength(2)
  const backfill = toolMsgs[0]
  expect(backfill.tool_call_id).toBe('call_2')
  expect(backfill.content).toContain('unavailable')
})

test('microcompact replaces old tool results with summaries', () => {
  const messages: Record<string, unknown>[] = [
    { role: 'system', content: 'test' },
  ]
  // 添加 15 个 read_file 结果
  for (let i = 0; i < 15; i++) {
    messages.push({
      role: 'tool',
      tool_call_id: `call_${i}`,
      name: 'read_file',
      content: 'A'.repeat(600), // 超过 MICROCOMPACT_MIN_CHARS
    })
  }

  const compacted = AgentRunner.microcompact(messages)
  // 前 5 个（15 - 10 KEEP）应该被压缩
  const compactedTools = compacted.filter((m) => m.role === 'tool')
  expect(compactedTools).toHaveLength(15)
  // 前 5 个已被替换为摘要
  for (let i = 0; i < 5; i++) {
    expect(compactedTools[i].content).toContain('omitted from context')
  }
  // 后 10 个保持原样
  for (let i = 5; i < 15; i++) {
    expect(compactedTools[i].content).toBe('A'.repeat(600))
  }
})

test('microcompact does not compact short results', () => {
  const messages: Record<string, unknown>[] = [
    { role: 'system', content: 'test' },
  ]
  for (let i = 0; i < 15; i++) {
    messages.push({
      role: 'tool',
      tool_call_id: `call_${i}`,
      name: 'read_file',
      content: 'short', // < MICROCOMPACT_MIN_CHARS
    })
  }

  const compacted = AgentRunner.microcompact(messages)
  const tools = compacted.filter((m) => m.role === 'tool')
  expect(tools.every((t) => t.content === 'short')).toBe(true)
})

test('applyToolResultBudget truncates long tool results', () => {
  const spec = createSpec({ maxToolResultChars: 10 })
  const messages = [
    { role: 'system', content: 'test' },
    { role: 'tool', tool_call_id: 't1', name: 'read_file', content: 'A'.repeat(100) },
    { role: 'tool', tool_call_id: 't2', name: 'ls', content: 'short' },
  ]
  const trimmed = AgentRunner.applyToolResultBudget(spec, messages)
  expect((trimmed[1].content as string).length).toBeLessThan(30)
  expect(trimmed[2].content).toBe('short')
})

// ============ 多工具调用 ============

test('run handles multiple tool calls in one response', async () => {
  const provider = new MockProvider([
    {
      content: null,
      finishReason: 'tool_calls',
      toolCalls: [
        { id: 'c1', type: 'function', function: { name: 'greet', arguments: '{"name":"Alice"}' } },
        { id: 'c2', type: 'function', function: { name: 'greet', arguments: '{"name":"Bob"}' } },
      ],
      usage: { promptTokens: 100, completionTokens: 40, totalTokens: 140 },
    },
    { content: 'done', finishReason: 'stop', toolCalls: [], usage: { promptTokens: 150, completionTokens: 10, totalTokens: 160 } },
  ])
  const runner = new AgentRunner(provider as any)
  const spec = createSpec()

  const result = await runner.run(spec)
  expect(result.stopReason).toBe('completed')
  expect(result.toolsUsed).toEqual(['greet', 'greet'])
  expect(result.messages.filter((m) => m.role === 'tool')).toHaveLength(2)
})
