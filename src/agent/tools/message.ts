/**
 * MessageTool —— 发送消息到聊天通道
 */
import { Tool, defineParams } from './base'
import type { OutboundMessage } from '../../bus'

export class MessageTool extends Tool {
  readonly name = 'message'
  readonly description = 'Send a message to the user. This is the ONLY way to deliver files (images, documents, audio, video) to the user.'
  readonly parameters = defineParams({
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The message content to send', minLength: 1 },
      channel: { type: 'string', description: 'Target channel' },
      chat_id: { type: 'string', description: 'Target chat/user ID' },
      media: { type: 'array', items: { type: 'string' }, description: 'File paths to attach' },
    },
    required: ['content'],
  })

  private sendCallback: ((msg: OutboundMessage) => Promise<void>) | null = null
  private defaultChannel = 'cli'
  private defaultChatId = 'direct'
  sentInTurn = false

  setContext(channel: string, chatId: string) { this.defaultChannel = channel; this.defaultChatId = chatId }
  setSendCallback(cb: (msg: OutboundMessage) => Promise<void>) { this.sendCallback = cb }
  startTurn() { this.sentInTurn = false }

  async execute(args: Record<string, unknown>): Promise<string> {
    const content = args.content as string
    const channel = (args.channel as string) || this.defaultChannel
    const chatId = (args.chat_id as string) || this.defaultChatId
    const media = (args.media as string[]) || []

    if (!this.sendCallback) return 'Error: Message sending not configured'
    try {
      await this.sendCallback({ channel, chatId, content, media, metadata: {}, buttons: [] })
      this.sentInTurn = true
      return `Message sent to ${channel}:${chatId}`
    } catch (err: unknown) {
      return `Error sending message: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}
