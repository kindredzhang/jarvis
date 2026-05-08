/**
 * 通用辅助函数
 *
 * 包含从 Python 原版 utils/runtime.py 和 utils/helpers.py
 * 1:1 移植的运行时工具函数。
 */

import { mkdir } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'

// ---- 从 Python 原版 runtime.py 移植的常量 ----

/** 重复外部查找的最大次数（web_search / web_fetch） */
export const MAX_REPEAT_EXTERNAL_LOOKUPS = 2

export const EMPTY_FINAL_RESPONSE_MESSAGE =
  "I completed the tool steps but couldn't produce a final answer. " +
  'Please try again or narrow the task.'

export const FINALIZATION_RETRY_PROMPT =
  'Please provide your response to the user based on the conversation above.'

export const LENGTH_RECOVERY_PROMPT =
  'Output limit reached. Continue exactly where you left off ' +
  '— no recap, no apology. Break remaining work into smaller steps if needed.'

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
 * ========= TODO: 与 Python 原版差异标注 =========
 * Python 原版使用 strip_think，包含更多逻辑
 */
/**
 * Split content into chunks within maxLen, preferring line breaks.
 * Port of original Python helpers.py split_message.
 */
export function splitMessage(content: string, maxLen: number = 2000): string[] {
  if (!content) return []
  if (content.length <= maxLen) return [content]
  const chunks: string[] = []
  let remaining = content
  while (remaining) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining)
      break
    }
    const cut = remaining.slice(0, maxLen)
    let pos = cut.lastIndexOf('\n')
    if (pos <= 0) pos = cut.lastIndexOf(' ')
    if (pos <= 0) pos = maxLen
    chunks.push(remaining.slice(0, pos))
    remaining = remaining.slice(pos).replace(/^\s+/, '')
  }
  return chunks
}

export function stripThinkTags(text: string): string {
  const THINK_CLOSE = "<" + "/think>"
  const re1 = new RegExp("<think[\\s\\S]*?" + THINK_CLOSE, "g")
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

// ---- 从 Python 原版 runtime.py 移植的函数 ----

/** 空工具结果的简短标记 */
export function emptyToolResultMessage(toolName: string): string {
  return `(${toolName} completed with no output)`
}

/** 将语义为空的工具结果替换为简短标记 */
export function ensureNonemptyToolResult(
  toolName: string,
  content: unknown,
): unknown {
  if (content === null || content === undefined) {
    return emptyToolResultMessage(toolName)
  }
  if (typeof content === 'string' && !content.trim()) {
    return emptyToolResultMessage(toolName)
  }
  if (Array.isArray(content)) {
    if (content.length === 0) {
      return emptyToolResultMessage(toolName)
    }
    const textPayload = stringifyTextBlocks(content)
    if (textPayload !== null && !textPayload.trim()) {
      return emptyToolResultMessage(toolName)
    }
  }
  return content
}

/** content 是否为空或只有空白 */
export function isBlankText(content: string | null | undefined): boolean {
  return content == null || content.trim() === ''
}

/** 构建无工具调用的 finalization retry 消息 */
export function buildFinalizationRetryMessage(): Record<string, string> {
  return { role: 'user', content: FINALIZATION_RETRY_PROMPT }
}

/** 构建 output token limit 后的恢复提示消息 */
export function buildLengthRecoveryMessage(): Record<string, string> {
  return { role: 'user', content: LENGTH_RECOVERY_PROMPT }
}

/** 提取文本块列表中的纯文本 */
export function stringifyTextBlocks(
  content: Record<string, unknown>[],
): string | null {
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) return null
    if (block.type !== 'text') return null
    const text = block.text
    if (typeof text !== 'string') return null
    parts.push(text)
  }
  return parts.join('\n')
}

/** 生成外部查找的稳定签名 */
export function externalLookupSignature(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  if (toolName === 'web_fetch') {
    const url = String(args.url ?? '').trim()
    if (url) return `web_fetch:${url.toLowerCase()}`
    return null
  }
  if (toolName === 'web_search') {
    const query = String(args.query ?? args.search_term ?? '').trim()
    if (query) return `web_search:${query.toLowerCase()}`
    return null
  }
  return null
}

/** 重复外部查找拦截 */
export function repeatedExternalLookupError(
  toolName: string,
  args: Record<string, unknown>,
  seenCounts: Record<string, number>,
): string | null {
  const signature = externalLookupSignature(toolName, args)
  if (signature === null) return null
  const count = (seenCounts[signature] ?? 0) + 1
  seenCounts[signature] = count
  if (count <= MAX_REPEAT_EXTERNAL_LOOKUPS) return null
  console.warn(
    `Blocking repeated external lookup ${signature.slice(0, 160)} on attempt ${count}`,
  )
  return (
    'Error: repeated external lookup blocked. ' +
    'Use the results you already have to answer, or try a meaningfully different source.'
  )
}

/** 找到第一个合法的消息起始位置（tool results 有匹配的 assistant calls） */
export function findLegalMessageStart(
  messages: Record<string, unknown>[],
): number {
  const declared = new Set<string>()
  let start = 0
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    const role = msg.role as string
    if (role === 'assistant') {
      const tcs = msg.tool_calls as Record<string, unknown>[] | undefined
      if (tcs) {
        for (const tc of tcs) {
          const id = tc.id as string | undefined
          if (id) declared.add(id)
        }
      }
    } else if (role === 'tool') {
      const tid = msg.tool_call_id as string | undefined
      if (tid && !declared.has(tid)) {
        start = i + 1
        declared.clear()
        for (let j = start; j <= i; j++) {
          const prev = messages[j]!
          if (prev.role === 'assistant') {
            const tcs = prev.tool_calls as Record<string, unknown>[] | undefined
            if (tcs) {
              for (const tc of tcs) {
                const id = tc.id as string | undefined
                if (id) declared.add(id)
              }
            }
          }
        }
      }
    }
  }
  return start
}