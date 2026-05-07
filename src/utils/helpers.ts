/**
 * 通用辅助函数
 */

import { mkdir } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'

/** 确保目录存在 */
export async function ensureDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true })
  return path
}

/** 截断文本，附加省略标记 */
export function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text
  return text.slice(0, maxChars) + "\n... (truncated)"
}

/** 同步版：读取文件，不存在返回空串 */
export function readTextSync(path: string): string {
  try {
    return readFileSync(path, "utf-8")
  } catch {
    return ""
  }
}

/** 同步版：写入文件（UTF-8） */
export function writeTextSync(path: string, content: string): void {
  writeFileSync(path, content, "utf-8")
}

/**
 * 清除思考标签（Agent内部推理过程不写入历史）
 *
 * ========= TODO: 与 nanobot 差异标注 =========
 * nanobot 使用 strip_think，包含更多逻辑
 */
export function stripThinkTags(text: string): string {
  const THINK_CLOSE = "<" + "/think>"
  const re1 = new RegExp("[\\s\\S]*?" + THINK_CLOSE, "g")
  let cleaned = text.replace(re1, "")
  cleaned = cleaned.replace(new RegExp("<think[\\s\\S]*$", "g"), "")
  return cleaned.trim()
}
export {}

/**
 * 检测图片 MIME 类型（魔数匹配，不依赖文件扩展名）
 */
export function detectImageMime(data: Uint8Array): string | null {
  // PNG
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  // JPEG
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  // GIF
  if ((data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38 && data[4] === 0x37) ||
      (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38 && data[4] === 0x39)) return 'image/gif'
  // WebP
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
      data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp'
  return null
}

/**
 * 当前时间字符串（含时区）
 *
 * 格式: "2026-05-07 15:30 (星期三) (Asia/Shanghai, UTC+08:00)"
 */
export function currentTimeStr(timezone?: string): string {
  const now = new Date()
  const tzName = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone

  const weekday = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][now.getDay()]
  const date = now.toISOString().slice(0, 10)
  const time = now.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })

  const offset = -now.getTimezoneOffset()
  const offsetSign = offset >= 0 ? '+' : '-'
  const offsetHours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')
  const offsetMins = String(Math.abs(offset) % 60).padStart(2, '0')

  return `${date} ${time} (${weekday}) (${tzName}, UTC${offsetSign}${offsetHours}:${offsetMins})`
}

/**
 * 构建 assistant 消息（provider-safe 格式）
 */
export function buildAssistantMessage(
  content: string | null,
  options?: {
    toolCalls?: Record<string, unknown>[]
    reasoningContent?: string | null
    thinkingBlocks?: Record<string, unknown>[]
  },
): Record<string, unknown> {
  const msg: Record<string, unknown> = { role: 'assistant', content: content ?? '' }
  if (options?.toolCalls && options.toolCalls.length > 0) {
    msg.tool_calls = options.toolCalls
  }
  if (options?.reasoningContent != null || options?.thinkingBlocks) {
    msg.reasoning_content = options.reasoningContent ?? ''
  }
  if (options?.thinkingBlocks) {
    msg.thinking_blocks = options.thinkingBlocks
  }
  return msg
}