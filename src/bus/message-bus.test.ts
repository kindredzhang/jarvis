import { test, expect } from 'bun:test'
import { MessageBus } from './message-bus'
import { InboundMessage } from './events'

test('publish and consume inbound message', async () => {
  const bus = new MessageBus()
  const msg = new InboundMessage({
    channel: 'feishu',
    senderId: 'user_1',
    chatId: 'chat_1',
    content: '你好',
  })

  bus.publishInbound(msg)
  const consumed = await bus.consumeInbound()

  expect(consumed.channel).toBe('feishu')
  expect(consumed.content).toBe('你好')
  expect(consumed.sessionKey).toBe('feishu:chat_1')
  expect(bus.inboundSize).toBe(0)
})

test('consume blocks until message arrives', async () => {
  const bus = new MessageBus()

  // 并发：一边等一边发
  const promise = bus.consumeInbound()

  setTimeout(() => {
    bus.publishInbound(
      new InboundMessage({
        channel: 'discord',
        senderId: 'u2',
        chatId: 'c2',
        content: 'hello',
      })
    )
  }, 10)

  const msg = await promise
  expect(msg.content).toBe('hello')
})

test('session key override', () => {
  const msg = new InboundMessage({
    channel: 'feishu',
    senderId: 'u1',
    chatId: 'chat_default',
    content: 'hi',
    sessionKeyOverride: 'thread:abc123',
  })
  expect(msg.sessionKey).toBe('thread:abc123')
})

test('publish and consume outbound', async () => {
  const bus = new MessageBus()
  const reply = { channel: 'feishu', chatId: 'chat_1', content: 'OK', media: [], metadata: {}, buttons: [] }

  bus.publishOutbound(reply)
  const consumed = await bus.consumeOutbound()

  expect(consumed.content).toBe('OK')
  expect(bus.outboundSize).toBe(0)
})
