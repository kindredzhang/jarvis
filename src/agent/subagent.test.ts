import { test, expect, describe } from 'bun:test'
import { SubagentManager } from './subagent'
import { LLMProvider } from '../providers/base'
import type { Message, LLMResponse } from '../providers/types'
import { join } from 'node:path'

class MockProvider extends LLMProvider {
  readonly model = 'mock-model'
  async generate(_msgs: Message[], _opts?: unknown): Promise<LLMResponse> {
    return {
      content: 'Subagent task completed.',
      finishReason: 'stop',
      toolCalls: [],
    }
  }
  async *generateStream(): AsyncIterable<never> { yield* [] }
}

describe('SubagentManager', () => {
  test('spawn returns task ID message', async () => {
    const manager = new SubagentManager({
      provider: new MockProvider() as any,
      workspace: '/tmp/test',
      model: 'test',
    })

    const result = await manager.spawn('Find all TypeScript files and count them.')
    expect(result).toContain('started')
    expect(result).toContain('id:')
  })

  test('getRunningCount tracks active tasks', async () => {
    const manager = new SubagentManager({
      provider: new MockProvider() as any,
      workspace: '/tmp/test',
      model: 'test',
    })

    expect(manager.getRunningCount()).toBe(0)

    await manager.spawn('Task 1')
    // After spawn, count should be 1 (task is running)
    expect(manager.getRunningCount()).toBe(1)

    await manager.spawn('Task 2')
    expect(manager.getRunningCount()).toBe(2)
  })

  test('callbacks are invoked on completion', async () => {
    const results: { taskId: string; result: string; status: string }[] = []
    const manager = new SubagentManager({
      provider: new MockProvider() as any,
      workspace: '/tmp/test',
      model: 'test',
      onResult: (taskId, result, status) => {
        results.push({ taskId, result, status })
      },
    })

    await manager.spawn('Simple task')
    // Wait for the task to complete
    await new Promise((r) => setTimeout(r, 100))

    expect(results.length).toBe(1)
    expect(results[0].status).toBe('ok')
    expect(results[0].result).toContain('completed')
  })

  test('cancelBySession returns count', async () => {
    const manager = new SubagentManager({
      provider: new MockProvider() as any,
      workspace: '/tmp/test',
      model: 'test',
    })

    await manager.spawn('Task 1', { sessionKey: 'session-a' })
    await manager.spawn('Task 2', { sessionKey: 'session-a' })

    const count = await manager.cancelBySession('session-a')
    expect(count).toBe(2)
  })

  test('getRunningCountBySession', async () => {
    const manager = new SubagentManager({
      provider: new MockProvider() as any,
      workspace: '/tmp/test',
      model: 'test',
    })

    await manager.spawn('Task for session A', { sessionKey: 'session-a' })

    const countA = manager.getRunningCountBySession('session-a')
    expect(countA).toBe(1)

    const countB = manager.getRunningCountBySession('session-b')
    expect(countB).toBe(0)
  })
})
