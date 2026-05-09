/**
 * Channel registry — auto-discovery for built-in channel modules.
 *
 * Port of original Python channels/registry.py.
 */

import type { BaseChannel } from './base'

// Built-in channels that have been ported to TypeScript
const _BUILTIN_CHANNELS: Record<string, () => Promise<new (...args: any[]) => BaseChannel>> = {
  feishu: () => import('./feishu').then((m) => m.FeishuChannel),
  whatsapp: () => import('./whatsapp').then((m) => m.WhatsAppChannel),
  telegram: () => import('./telegram').then((m) => m.TelegramChannel),
  discord: () => import('./discord').then((m) => m.DiscordChannel),
  slack: () => import('./slack').then((m) => m.SlackChannel),
  dingtalk: () => import('./dingtalk').then((m) => m.DingTalkChannel),
  wecom: () => import('./wecom').then((m) => m.WeComChannel),
  email: () => import('./email').then((m) => m.EmailChannel),
  websocket: () => import('./websocket').then((m) => m.WebSocketChannel),
  weixin: () => import('./weixin').then((m) => m.WeixinChannel as any),
}

/**
 * Return all built-in channel module names.
 */
export function discoverChannelNames(): string[] {
  return Object.keys(_BUILTIN_CHANNELS)
}

/**
 * Load a channel class by module name.
 */
export async function loadChannelClass(moduleName: string): Promise<new (...args: any[]) => BaseChannel> {
  const loader = _BUILTIN_CHANNELS[moduleName]
  if (!loader) {
    throw new Error(`Channel '${moduleName}' not found. Available: ${discoverChannelNames().join(', ')}`)
  }
  return loader()
}

/**
 * Discover all available channels (built-in).
 * External plugin discovery via entry points is not yet implemented in the TS port.
 */
export async function discoverAll(): Promise<Record<string, new (...args: any[]) => BaseChannel>> {
  const channels: Record<string, new (...args: any[]) => BaseChannel> = {}

  for (const name of discoverChannelNames()) {
    try {
      channels[name] = await loadChannelClass(name)
    } catch (err) {
      console.warn(`[channels] Skipping '${name}': ${err}`)
    }
  }

  return channels
}
