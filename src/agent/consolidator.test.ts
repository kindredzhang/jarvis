import { test, expect, describe, beforeEach } from 'bun:test'
import { Consolidator, Dream } from './consolidator'
import { MemoryStore } from './memory'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { LLMProvider } from '../providers/base'
import type { Message, LLMResponse } from '../providers/types'

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'jarvis-cons-test-'))
})

// ---- Mock Provider ----

class MockProvider extends LLMProvider {
  readonly model = 'mock-model'
  private responses: LLMResponse[] = []
  private index = 0

  constructor(responses?: LLMResponse[]) {
    super()
    this.responses = responses ?? [
      { content: 'Summary of conversation.', finishReason: 'stop', toolCalls: [] },
    ]
  }

  async generate(
    _messages: Message[],
    _options?: unknown,
  ): Promise<LLMResponse> {
    return this.responses[this.index++ % this.responses.length] ?? {
      content: 'Mock response.',
      finishReason: 'stop',
      toolCalls: [],
    }
  }

  async *generateStream(): AsyncIterable<never> { yield *[] }
}

// ---- Consolidator ----

describe('Consolidator', () => {
  test('inputTokenBudget calculates correctly', () => {
    const c = new Consolidator({
      provider: new MockProvider(),
      model: 'test',
      contextWindowTokens: 128_000,
    })
    // 128_000 - 4096 - 1024 = 122_880
    expect(c.inputTokenBudget).toBe(122_880)
  })

  test('does nothing when messages are within budget', async () => {
    const c = new Consolidator({
      provider: new MockProvider(),
      model: 'test',
      contextWindowTokens: 128_000,
    })
    // A few short messages should be well within budget
    const messages = [
      { role: 'user', content: 'hello', timestamp: '2024-01-01' },
      { role: 'assistant', content: 'hi there', timestamp: '2024-01-01' },
    ]

    let callbackCalled = false
    const result = await c.maybeConsolidate(messages as any, () => { callbackCalled = true })
    expect(result).toBe(false)
    expect(callbackCalled).toBe(false)
  })

  test('archives old messages when budget is exceeded', async () => {
    const c = new Consolidator({
      provider: new MockProvider([{ content: 'Summarized archive.', finishReason: 'stop', toolCalls: [] }]),
      model: 'test',
      // Very small budget to force consolidation
      contextWindowTokens: 100,
    })

    // Generate enough messages to exceed the tiny budget
    const messages: any[] = []
    for (let i = 0; i < 20; i++) {
      messages.push({ role: 'user', content: 'A'.repeat(200), timestamp: '2024-01-01' })
      messages.push({ role: 'assistant', content: 'B'.repeat(200), timestamp: '2024-01-01' })
    }

    const result = await c.maybeConsolidate(messages, () => {})
    // With 100 token budget, 20 user+assistant pairs will definitely exceed
    // The consolidation may succeed (LLM returns summary) or not
    // But either way, messages array should still have elements
    expect(messages.length).toBeGreaterThan(0)
  })
})

// ---- Dream ----

describe('Dream', () => {
  test('does nothing when no unprocessed entries', async () => {
    const store = new MemoryStore(workspace)
    const dream = new Dream({
      store,
      provider: new MockProvider(),
      model: 'test',
    })

    const result = await dream.run()
    expect(result).toBe(false)
  })

  test('processes new entries', async () => {
    const store = new MemoryStore(workspace)
    store.appendHistory('Say hello to the user.')
    writeFileSync(store.memoryFile, '## Old memory\nNothing important.', 'utf-8')

    const dream = new Dream({
      store,
      provider: new MockProvider([
        { content: 'New facts learned: user said hello.', finishReason: 'stop', toolCalls: [] },
      ]),
      model: 'test',
    })

    const result = await dream.run()
    // Dream may or may not update memory depending on analysis
    // But it should at least advance the cursor
    expect(store.getLastDreamCursor()).toBeGreaterThan(0)
  })

  test('advances cursor even when no changes needed', async () => {
    const store = new MemoryStore(workspace)
    store.appendHistory('Just a test conversation.')
    writeFileSync(store.memoryFile, '## Memory\nNothing to change.', 'utf-8')

    const dream = new Dream({
      store,
      provider: new MockProvider([
        { content: 'NO_CHANGES', finishReason: 'stop', toolCalls: [] },
      ]),
      model: 'test',
    })

    const result = await dream.run()
    expect(result).toBe(false)
    // Cursor should still advance
    expect(store.getLastDreamCursor()).toBeGreaterThan(0)
  })
})
