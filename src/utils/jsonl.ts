/**
 * JSONL 文件读写工具
 *
 * 提供对 .jsonl 格式文件的追加/读取/覆盖操作。
 */

import { readFileSync, writeFileSync } from 'node:fs'

export namespace JSONL {
  /** 读取所有 JSONL 条目 */
  export function readAll<T>(filePath: string): T[] {
    try {
      const content = readFileSync(filePath, 'utf-8')
      return content
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          try { return JSON.parse(line) as T }
          catch { return null }
        })
        .filter((entry): entry is T => entry !== null)
    } catch {
      return []
    }
  }

  /** 读取最后一条 JSONL 条目 */
  export function readLast<T>(filePath: string): T | null {
    try {
      const content = readFileSync(filePath, 'utf-8')
      const lines = content.split('\n').filter((line) => line.trim())
      if (lines.length === 0) return null
      const lastLine = lines.at(-1)
      if (!lastLine) return null
      return JSON.parse(lastLine) as T
    } catch {
      return null
    }
  }

  /** 写入所有条目（覆盖） */
  export function writeAll<T>(filePath: string, entries: T[]): void {
    const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
    writeFileSync(filePath, content, 'utf-8')
  }

  /** 追加一条记录 */
  export function append<T>(filePath: string, record: T): void {
    const line = JSON.stringify(record) + '\n'
    writeFileSync(filePath, line, { encoding: 'utf-8', flag: 'a' })
  }
}
