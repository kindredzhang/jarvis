import { test, expect, describe } from 'bun:test'
import { CommandRouter } from './router'
import type { CommandContext } from './router'

describe('CommandRouter', () => {
  test('exact match dispatches correctly', async () => {
    const router = new CommandRouter()
    router.exactCmd('/hello', async (ctx) => ({
      channel: ctx.channel,
      chatId: ctx.chatId,
      content: `Hello, ${ctx.sessionKey}!`,
      metadata: {},
      media: [],
      buttons: [],
    }))

    const result = await router.dispatch({
      raw: '/hello', args: '', sessionKey: 'test:1',
      channel: 'cli', chatId: '1', metadata: {},
    })
    expect(result).not.toBeNull()
    expect(result!.content).toBe('Hello, test:1!')
  })

  test('priority commands dispatch before normal', async () => {
    const router = new CommandRouter()
    router.priorityCmd('/stop', async () => ({
      channel: 'cli', chatId: '1', content: 'stopped',
      metadata: { priority: true }, media: [], buttons: [],
    }))

    const isPri = router.isPriority('/stop')
    expect(isPri).toBe(true)
    expect(router.isPriority('/help')).toBe(false)
  })

  test('prefix match with args extraction', async () => {
    const router = new CommandRouter()
    router.prefixCmd('/dream-log ', async (ctx) => ({
      channel: ctx.channel, chatId: ctx.chatId,
      content: `log: ${ctx.args}`,
      metadata: {}, media: [], buttons: [],
    }))

    const result = await router.dispatch({
      raw: '/dream-log abc123', args: '',
      sessionKey: 'test:1', channel: 'cli', chatId: '1',
      metadata: {},
    })
    expect(result).not.toBeNull()
    expect(result!.content).toBe('log: abc123')
  })

  test('isDispatchableCommand returns true for registered commands', () => {
    const router = new CommandRouter()
    router.exactCmd('/help', async () => null)
    router.prefixCmd('/dream ', async () => null)

    expect(router.isDispatchableCommand('/help')).toBe(true)
    expect(router.isDispatchableCommand('/dream something')).toBe(true)
    expect(router.isDispatchableCommand('/unknown')).toBe(false)
  })

  test('prefix sorted by length descending', () => {
    const router = new CommandRouter()
    const order: string[] = []
    router.prefixCmd('/a', async () => { order.push('/a'); return null })
    router.prefixCmd('/ab', async () => { order.push('/ab'); return null })

    // Should match /ab first (longer prefix)
    router.dispatch({ raw: '/abc', args: '', sessionKey: 't', channel: 'c', chatId: '1', metadata: {} })
    expect(order).toEqual(['/ab'])
  })

  test('returns null for unmatched command', async () => {
    const router = new CommandRouter()
    const result = await router.dispatch({
      raw: '/nothing', args: '', sessionKey: 't',
      channel: 'c', chatId: '1', metadata: {},
    })
    expect(result).toBeNull()
  })

  test('builtin commands register correctly', async () => {
    const router = new CommandRouter()
    const { registerBuiltinCommands } = await import('./builtin')
    registerBuiltinCommands(
      (cmd, h) => router.priorityCmd(cmd, h),
      (cmd, h) => router.exactCmd(cmd, h),
    )

    expect(router.isPriority('/stop')).toBe(true)
    expect(router.isDispatchableCommand('/help')).toBe(true)
    expect(router.isDispatchableCommand('/new')).toBe(true)

    const help = await router.dispatch({
      raw: '/help', args: '', sessionKey: 't',
      channel: 'c', chatId: '1', metadata: {},
    })
    expect(help).not.toBeNull()
    expect(help!.content).toContain('/help')
    expect(help!.content).toContain('/stop')
    expect(help!.content).toContain('/new')
  })
})
