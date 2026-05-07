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