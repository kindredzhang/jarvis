import { AsyncQueue } from './queue'
import { InboundMessage, type OutboundMessage } from './events'

/**
 * 消息总线 —— 解耦通道层与 Agent 核心层
 *
 * - 通道推送消息到入站队列（publishInbound）
 * - Agent 从入站队列消费消息（consumeInbound）
 * - Agent 处理完成后发布响应到出站队列（publishOutbound）
 * - 通道从出站队列消费响应并发送（consumeOutbound）
 */
export class MessageBus {
  readonly inbound = new AsyncQueue<InboundMessage>()
  readonly outbound = new AsyncQueue<OutboundMessage>()

  /** 发布来自通道的消息到 Agent */
  publishInbound(msg: InboundMessage): void {
    this.inbound.put(msg)
  }

  /** 消费下一条入站消息（队列为空时阻塞） */
  consumeInbound(): Promise<InboundMessage> {
    return this.inbound.get()
  }

  /** 发布来自 Agent 的响应到通道 */
  publishOutbound(msg: OutboundMessage): void {
    this.outbound.put(msg)
  }

  /** 消费下一条出站消息（队列为空时阻塞） */
  consumeOutbound(): Promise<OutboundMessage> {
    return this.outbound.get()
  }

  /** 入站队列长度 */
  get inboundSize(): number {
    return this.inbound.size
  }

  /** 出站队列长度 */
  get outboundSize(): number {
    return this.outbound.size
  }
}
