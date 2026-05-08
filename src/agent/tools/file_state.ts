/**
 * file_state —— 文件读写去重状态追踪
 * 记录 ReadFileTool 的读取状态，避免 LLM 重复读取未变更文件。
 */
import { readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'

interface Entry { mtime: number; offset: number; limit: number; canDedup: boolean; contentHash: string }

class FileState {
  private map = new Map<string, Entry>()

  recordRead(fp: string, offset = 1, limit = 2000) {
    try {
      const st = statSync(fp)
      this.map.set(fp, { mtime: st.mtimeMs, offset, limit, canDedup: true, contentHash: this._hash(fp) })
    } catch { /* ignore */ }
  }

  recordWrite(fp: string) { this.map.delete(fp) }

  checkRead(fp: string): string | null {
    const prev = this.map.get(fp)
    if (!prev || !prev.canDedup) return null
    try {
      const mtime = statSync(fp).mtimeMs
      if (mtime === prev.mtime) {
        const currentHash = this._hash(fp)
        if (currentHash === prev.contentHash) return `[File unchanged since last read: ${fp}]`
      }
    } catch { /* ignore */ }
    return null
  }

  private _hash(fp: string): string {
    return createHash('sha256').update(readFileSync(fp)).digest('hex').slice(0, 16)
  }
}

export const fileState = new FileState()
