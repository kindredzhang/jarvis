import { test, expect, describe } from 'bun:test'
import { AnthropicProvider } from './anthropic'

describe('AnthropicProvider', () => {
  test('convertMessages extracts system prompt', () => {
    const provider = new AnthropicProvider({ apiKey: 'test-key', model: 'claude-sonnet-4-20250514' })
    const { system, anthropicMessages } = provider.convertMessages([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello!' },
    ])

    expect(system).toBe('You are a helpful assistant.')
    expect(anthropicMessages).toHaveLength(1)
    expect(anthropicMessages[0].role).toBe('user')
  })

  test('convertMessages handles tool results', () => {
    const provider = new AnthropicProvider({ apiKey: 'test-key', model: 'claude-sonnet-4-20250514' })
    const { anthropicMessages } = provider.convertMessages([
      { role: 'user', content: 'Count files' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: 'call_1', type: 'function', function: { name: 'exec', arguments: '{"command":"ls"}' } },
        ],
      },
      { role: 'tool', toolCallId: 'call_1', name: 'exec', content: 'file1.txt\nfile2.txt' },
    ])

    expect(anthropicMessages).toHaveLength(3)
    // Tool result should be embedded in a user message
    const lastMsg = anthropicMessages[anthropicMessages.length - 1]
    expect(lastMsg.role).toBe('user')
    expect(lastMsg.content[0].type).toBe('tool_result')
    expect((lastMsg.content[0] as any).tool_use_id).toBe('call_1')
  })

  test('convertMessages handles assistant with tool_use blocks', () => {
    const provider = new AnthropicProvider({ apiKey: 'test-key', model: 'claude-sonnet-4-20250514' })
    const { anthropicMessages } = provider.convertMessages([
      { role: 'user', content: 'Run command' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: 'tc_1', type: 'function', function: { name: 'exec', arguments: '{"command":"ls"}' } },
        ],
      },
    ])

    const assistant = anthropicMessages[1]
    expect(assistant.role).toBe('assistant')
    expect(assistant.content).toHaveLength(1)
    expect(assistant.content[0].type).toBe('tool_use')
    expect((assistant.content[0] as any).name).toBe('exec')
  })

  test('convertTools transforms tool definitions', () => {
    const provider = new AnthropicProvider({ apiKey: 'test-key' })
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    ]

    const result = (provider as any).convertTools(tools)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('read_file')
    expect(result[0].description).toBe('Read a file')
    expect(result[0].input_schema).toBeDefined()
  })

  test('parseResponse extracts text content', () => {
    const provider = new AnthropicProvider({ apiKey: 'test-key' })
    const data = {
      content: [
        { type: 'text', text: 'Hello! The answer is 42.' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    }

    const response = (provider as any).parseResponse(data)
    expect(response.content).toBe('Hello! The answer is 42.')
    expect(response.finishReason).toBe('stop')
    expect(response.toolCalls).toHaveLength(0)
    expect(response.usage.promptTokens).toBe(10)
    expect(response.usage.completionTokens).toBe(5)
  })

  test('parseResponse extracts tool_use blocks', () => {
    const provider = new AnthropicProvider({ apiKey: 'test-key' })
    const data = {
      content: [
        { type: 'text', text: 'Let me check:' },
        {
          type: 'tool_use',
          id: 'toolu_123',
          name: 'read_file',
          input: { path: '/tmp/test.txt' },
        },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 20, output_tokens: 10 },
    }

    const response = (provider as any).parseResponse(data)
    expect(response.content).toBe('Let me check:')
    expect(response.finishReason).toBe('tool_calls')
    expect(response.toolCalls).toHaveLength(1)
    expect(response.toolCalls[0].id).toBe('toolu_123')
    expect(response.toolCalls[0].function.name).toBe('read_file')
    expect(response.toolCalls[0].function.arguments).toContain('/tmp/test.txt')
  })

  test('constructor uses default model', () => {
    const provider = new AnthropicProvider({ apiKey: 'test-key' })
    expect(provider.model).toContain('claude')
  })

  test('constructor uses custom config', () => {
    const provider = new AnthropicProvider({
      apiKey: 'sk-ant-custom',
      model: 'claude-opus-4-20250514',
      baseUrl: 'https://custom.anthropic.com',
      maxTokens: 8192,
    })
    expect(provider.model).toBe('claude-opus-4-20250514')
  })
})
