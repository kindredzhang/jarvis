/**
 * ChannelManager — coordinating chat channels.
 *
 * Port of original Python project.
 * Manages channel lifecycle and routes outbound messages.
 */

import type { OutboundMessage } from '../bus'
import type { MessageBus } from '../bus/message-bus'
import type { BaseChannel } from './base'
import { discoverAll } from './registry'
import { consumeRestartNoticeFromEnv, formatRestartCompletedMessage } from '../utils/restart'

// Retry delays for message sending (exponential backoff: 1s, 2s, 4s)
const SEND_RETRY_DELAYS: number[] = [1, 2, 4]

export interface ChannelManagerConfig {
  /** Channel config sections keyed by channel name */
  channels: Record<string, Record<string, unknown>>
  /** Maximum send retries */
  sendMaxRetries?: number
  /** Send tool hint progress messages */
  sendToolHints?: boolean
  /** Send progress messages */
  sendProgress?: boolean
  /** Transcription provider (for voice messages) */
  transcriptionProvider?: string
  /** Transcription language */
  transcriptionLanguage?: string
}

export class ChannelManager {
  readonly channels: Map<string, BaseChannel> = new Map()
  private bus: MessageBus
  private config: ChannelManagerConfig
  private dispatchTask: Promise<void> | null = null
  private abortController = new AbortController()

  constructor(bus: MessageBus, config: ChannelManagerConfig) {
    this.bus = bus
    this.config = config
  }

  async initChannels(): Promise<void> {
    const allChannels = await discoverAll()

    for (const [name, cls] of Object.entries(allChannels)) {
      const section = this.config.channels[name]
      if (!section) continue

      const enabled = section.enabled === true
      if (!enabled) continue

      try {
        const channel = new cls(section, this.bus) as BaseChannel
        this.channels.set(name, channel)
      } catch (err) {
        console.warn(`[channels] ${name} not available: ${err}`)
      }
    }

    this.validateAllowFrom()
  }

  private validateAllowFrom(): void {
    for (const [name, channel] of this.channels) {
      const config = (channel as any).config ?? {}
      const allowFrom = config.allowFrom ?? config.allow_from
      if (Array.isArray(allowFrom) && allowFrom.length === 0) {
        throw new Error(
          `"${name}" has empty allowFrom (denies all). Set ["*"] to allow everyone.`,
        )
      }
    }
  }

  async startAll(): Promise<void> {
    if (this.channels.size === 0) {
      console.warn('[channels] No channels enabled')
      return
    }

    // Start outbound dispatcher
    this.dispatchTask = this.dispatchOutbound()

    // Start each channel
    const tasks: Promise<void>[] = []
    for (const [name, channel] of this.channels) {
      tasks.push(
        channel.start().catch((err) => {
          console.error(`[channels] Failed to start ${name}: ${err}`)
        }),
      )
    }

    await Promise.all(tasks)

    // Notify restart completion if applicable
    this.notifyRestartDoneIfNeeded()
  }

  async stopAll(): Promise<void> {
    this.abortController.abort()

    if (this.dispatchTask) {
      try {
        await this.dispatchTask
      } catch {
        // ignore cancellation
      }
    }

    const stopPromises: Promise<void>[] = []
    for (const [name, channel] of this.channels) {
      stopPromises.push(
        channel.stop().catch((err) => {
          console.error(`[channels] Error stopping ${name}: ${err}`)
        }),
      )
    }
    await Promise.all(stopPromises)
  }

  private async dispatchOutbound(): Promise<void> {
    while (!this.abortController.signal.aborted) {
      try {
        const msg = await this.bus.consumeOutbound()

        // Filter progress/tool_hint messages
        if (msg.metadata?._progress) {
          const ch = this.config
          if (msg.metadata._toolHint && !ch.sendToolHints) continue
          if (!msg.metadata._toolHint && !ch.sendProgress) continue
        }

        if (msg.metadata?._retryWait) continue

        const channel = this.channels.get(msg.channel)
        if (!channel) {
          console.warn(`[channels] Unknown channel: ${msg.channel}`)
          continue
        }

        await this.sendWithRetry(channel, msg)
      } catch (err) {
        if (this.abortController.signal.aborted) break
      }
    }
  }

  private async sendOnce(channel: BaseChannel, msg: OutboundMessage): Promise<void> {
    if (msg.metadata?._streamDelta || msg.metadata?._streamEnd) {
      await channel.sendDelta?.(msg.chatId, msg.content, msg.metadata)
    } else if (!msg.metadata?._streamed) {
      await channel.send(msg)
    }
  }

  private async sendWithRetry(channel: BaseChannel, msg: OutboundMessage): Promise<void> {
    const maxAttempts = Math.max(this.config.sendMaxRetries ?? 3, 1)

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await this.sendOnce(channel, msg)
        return
      } catch (err) {
        if (attempt === maxAttempts - 1) {
          console.error(`[channels] Failed to send to ${msg.channel} after ${maxAttempts} attempts: ${err}`)
          return
        }
        const delay = SEND_RETRY_DELAYS[Math.min(attempt, SEND_RETRY_DELAYS.length - 1)] ?? 1
        console.warn(`[channels] Send to ${msg.channel} failed (attempt ${attempt + 1}/${maxAttempts}): ${err}, retrying in ${delay}s`)
        await new Promise((resolve) => setTimeout(resolve, delay * 1000))
      }
    }
  }

  /**
   * Send restart-completed notification to the channel that initiated the restart.
   */
  private notifyRestartDoneIfNeeded(): void {
    const notice = consumeRestartNoticeFromEnv()
    if (!notice) return
    const target = this.channels.get(notice.channel)
    if (!target) return
    const msg = formatRestartCompletedMessage(notice.startedAtRaw)
    target.send({
      channel: notice.channel,
      chatId: notice.chatId,
      content: msg,
      metadata: {},
      media: [],
      buttons: [],
    }).catch((err) => {
      console.warn(`[channels] Restart notification failed: ${err}`)
    })
  }

  getChannel(name: string): BaseChannel | undefined {
    return this.channels.get(name)
  }

  get enabledChannels(): string[] {
    return [...this.channels.keys()]
  }

  getStatus(): Record<string, { enabled: boolean; running: boolean }> {
    const status: Record<string, { enabled: boolean; running: boolean }> = {}
    for (const [name, channel] of this.channels) {
      status[name] = {
        enabled: true,
        running: channel.isRunning,
      }
    }
    return status
  }
}
