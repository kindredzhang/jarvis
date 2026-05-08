import { test, expect, describe } from 'bun:test'
import { SpawnTool } from './spawn'
import { SubagentManager } from '../subagent'
import { LLMProvider } from '../../providers/base'
import type { Message, LLMResponse } from '../../providers/types'

class MockProvider extends LLMProvider {
  readonly model = 'mock-model'
  async generate(_msgs: Message[], _opts?: unknown): Promise<LLMResponse> {
    return { content: 'done', finishReason: 'stop', toolCalls: [] }
  }
  async *generateStream(): AsyncIterable<never> { yield* [] }
}

describe('SpawnTool', () => {
  test('executes spawn and returns task ID', async () => {
    const manager = new SubagentManager({
      provider: new MockProvider() as any,
      workspace: '/tmp/test',
      model: 'test',
    })
    const tool = new SpawnTool(manager)

    const result = await tool.execute({ task: 'Find all TypeScript files.' })
    expect(result).toContain('started')
    expect(result).toContain('Subagent')
  })

  test('executes spawn with optional label', async () => {
    const manager = new SubagentManager({
      provider: new MockProvider() as any,
      workspace: '/tmp/test',
      model: 'test',
    })
    const tool = new SpawnTool(manager)

    const result = await tool.execute({ task: 'Count lines.', label: 'line-counter' })
    expect(result).toContain('line-counter')
  })

  test('returns error for empty task', async () => {
    const manager = new SubagentManager({
      provider: new MockProvider() as any,
      workspace: '/tmp/test',
      model: 'test',
    })
    const tool = new SpawnTool(manager)

    const result = await tool.execute({})
    expect(result).toContain('No task')
  })
})
