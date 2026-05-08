/**
 * 文件系统工具 —— 读写编辑列表
 *
 * ========= TODO: 与 nanobot 差异标注 =========
 * 以下在 nanobot/agent/tools/filesystem.py 中存在，本文件暂未实现：
 * - PDF 阅读支持（pymupdf/fitz）
 * - Office 文档支持（.docx/.xlsx/.pptx 提取文本）
 * - 图片 MIME 检测与 ContentBlock 返回（build_image_content_blocks）
 * - file_state 读写去重状态追踪（防止 LLM 重复读取同一内容）
 * - CRLF/LF 转换保护（uses_crlf 保留原始行尾）
 * - _is_blocked_device：/dev/* 设备路径黑名单
 * - _parse_page_range：PDF 页码范围解析
 * - EditFileTool 引号样式保留（_preserve_quote_style / _curly_quotes）
 * - EditFileTool 缩进对齐（_reindent_like_match）
 * - EditFileTool .ipynb 检测重定向到 notebook_edit
 * - EditFileTool 文件大小保护（1 GiB 上限）
 * - EditFileTool 创建文件语义（old_text='' + 文件不存在 → 新建）
 * - EditFileTool read-before-edit 警告
 * - ListDirTool emoji 标识（📁/📄）
 * - file_state.record_read/record_write 调用
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs'
import { join, relative, dirname, extname, basename } from 'node:path'
import { Tool, defineParams } from './base'
import { stripThinkTags } from '../../utils/helpers'
import { extractDocumentText } from '../../utils/document'

// ---- 共享工具基类 ----

/** 路径解析：将相对路径对齐到 workspace，检查 allowed_dir 限制 */
function resolvePath(
  path: string,
  workspace: string | undefined,
  allowedDir: string | null | undefined,
  extraAllowedDirs: string[] | null | undefined,
): string {
  let resolved: string
  if (path.startsWith('/')) {
    resolved = path
  } else if (workspace) {
    resolved = join(workspace, path)
  } else if (allowedDir) {
    resolved = join(allowedDir as string, path)
  } else {
    resolved = path
  }
  resolved = resolved.replace(/\/+/g, '/') // normalize
  // 安全检查：如果指定了 allowedDir，路径必须在其下
  if (allowedDir) {
    const realAllowed = allowedDir.replace(/\/+$/, '')
    const realResolved = resolved.replace(/\/+$/, '')
    if (!realResolved.startsWith(realAllowed + '/') && realResolved !== realAllowed) {
      // 检查 extra allowed dirs
      const extra = extraAllowedDirs ?? []
      const inExtra = extra.some(d => {
        const real = d.replace(/\/+$/, '')
        return realResolved.startsWith(real + '/') || realResolved === real
      })
      if (!inExtra) {
        throw new Error(`Path ${path} is outside allowed directory ${allowedDir}`)
      }
    }
  }
  return resolved
}

function isUnder(path: string, directory: string): boolean {
  const rel = relative(directory, path)
  return !rel.startsWith('..') && rel !== ''
}

/** 共享基类 */
abstract class FsTool extends Tool {
  protected workspace: string | undefined
  protected allowedDir: string | null = null
  protected extraAllowedDirs: string[] | null = null

  constructor(
    workspace?: string,
    allowedDir?: string | null,
    extraAllowedDirs?: string[] | null,
  ) {
    super()
    this.workspace = workspace
    this.allowedDir = allowedDir ?? null
    this.extraAllowedDirs = extraAllowedDirs ?? null
  }

  protected _resolve(path: string): string {
    return resolvePath(path, this.workspace, this.allowedDir, this.extraAllowedDirs)
  }
}

// ---- ReadFileTool ----

export class ReadFileTool extends FsTool {
  readonly name = 'read_file'
  readonly description =
    'Read a file. Text output format: LINE_NUM|CONTENT. ' +
    'Use offset and limit for large files. Reads exceeding ~128K chars are truncated.'
  readonly parameters = defineParams({
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The file path to read' },
      offset: { type: 'integer', description: 'Line number to start reading from (1-indexed, default 1)', minimum: 1 },
      limit: { type: 'integer', description: 'Maximum number of lines to read (default 2000)', minimum: 1 },
    },
    required: ['path'],
  })

  private static readonly MAX_CHARS = 128_000
  private static readonly DEFAULT_LIMIT = 2000

  async execute(args: Record<string, unknown>): Promise<string> {
    try {
      const path = args.path as string | undefined
      if (!path) return 'Error reading file: Unknown path'

      const offset = Math.max(1, (args.offset as number | undefined) ?? 1)
      const limit = Math.max(1, (args.limit as number | undefined) ?? ReadFileTool.DEFAULT_LIMIT)

      const fp = this._resolve(path)
      if (!existsSync(fp)) return `Error: File not found: ${path}`

      // 目录检测
      try {
        const st = statSync(fp)
        if (st.isDirectory()) return `Error: Not a file: ${path}`
      } catch {
        return `Error: File not found: ${path}`
      }

      let text: string
      try {
        text = readFileSync(fp, 'utf-8')
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        // 文档文件提取文本
      const ext$ = extname(fp).toLowerCase()
      if ([".pdf", ".docx", ".xlsx", ".pptx"].includes(ext$)) {
        const docText = extractDocumentText(fp)
        if (docText) {
          const maxChars = ReadFileTool.MAX_CHARS
          return docText.length > maxChars
            ? docText.slice(0, maxChars) + "\n\n(Document text truncated at ~128K chars)"
            : docText
        }
        if (ext$ === ".pdf") {
          return "Error: Cannot read PDF. Install pymupdf: pip install pymupdf"
        }
        return "Error: Cannot read " + ext$ + " file. Try textutil (macOS) or install python-docx/openpyxl/python-pptx"
      }

      // 可能是二进制文件
        if (msg.includes('invalid utf') || msg.includes('encoding')) {
          return `Error: Cannot read binary file ${path}. Only UTF-8 text is supported.`
        }
        return `Error reading file: ${msg}`
      }

      // 规范化 CRLF → LF
      text = text.replace(/\r\n/g, '\n')

      // strip think tags
      text = stripThinkTags(text)

      if (!text) return `(Empty file: ${path})`

      const allLines = text.split('\n')
      const total = allLines.length

      if (offset > total) {
        return `Error: offset ${offset} is beyond end of file (${total} lines)`
      }

      const start = offset - 1
      const end = Math.min(start + limit, total)
      const slice = allLines.slice(start, end)
      const numbered = slice.map((line, i) => `${start + i + 1}|${line}`)
      let result = numbered.join('\n')

      // 字符上限
      if (result.length > ReadFileTool.MAX_CHARS) {
        result = result.slice(0, ReadFileTool.MAX_CHARS)
        result += '\n\n(Showing lines ${offset}-${start + numbered.length} of ${total} — truncated at ~128K chars)'
      } else if (end < total) {
        result += `\n\n(Showing lines ${offset}-${end} of ${total}. Use offset=${end + 1} to continue.)`
      } else {
        result += `\n\n(End of file — ${total} lines total)`
      }

      return result
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('outside allowed directory')) return `Error: ${msg}`
      return `Error reading file: ${msg}`
    }
  }
}

// ---- WriteFileTool ----

export class WriteFileTool extends FsTool {
  readonly name = 'write_file'
  readonly description =
    'Write content to a file. Overwrites if the file already exists; ' +
    'creates parent directories as needed. For partial edits, prefer edit_file instead.'
  readonly parameters = defineParams({
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The file path to write to' },
      content: { type: 'string', description: 'The content to write' },
    },
    required: ['path', 'content'],
  })

  async execute(args: Record<string, unknown>): Promise<string> {
    try {
      const path = args.path as string | undefined
      if (!path) throw new Error('Unknown path')
      const content = args.content as string | undefined
      if (content === undefined) throw new Error('Unknown content')

      const fp = this._resolve(path)
      // 创建父目录
      const dir = dirname(fp)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

      writeFileSync(fp, content, 'utf-8')
      return `Successfully wrote ${content.length} characters to ${fp}`
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('outside allowed directory')) return `Error: ${msg}`
      return `Error writing file: ${msg}`
    }
  }
}

// ---- EditFileTool ----

export class EditFileTool extends FsTool {
  readonly name = 'edit_file'
  readonly description =
    'Edit a file by replacing old_text with new_text. ' +
    'Tolerates minor whitespace/indentation differences. ' +
    'If old_text appears multiple times, you must provide more context ' +
    'or set replace_all=true.'
  readonly parameters = defineParams({
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The file path to edit' },
      old_text: { type: 'string', description: 'The text to find and replace' },
      new_text: { type: 'string', description: 'The text to replace with' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences (default false)' },
    },
    required: ['path', 'old_text', 'new_text'],
  })

  /** 去除每行尾部空白 */
  private static _stripTrailingWs(text: string): string {
    return text.split('\n').map(line => line.replace(/\s+$/, '')).join('\n')
  }

  /** 查找匹配位置 —— 多级降级策略 */
  private static _findMatch(content: string, oldText: string): { text: string; start: number; end: number; line: number }[] {
    const results: { text: string; start: number; end: number; line: number }[] = []

    // 1. 精确匹配
    let idx = 0
    let searchFrom = 0
    while ((idx = content.indexOf(oldText, searchFrom)) !== -1) {
      const start = idx
      const end = idx + oldText.length
      const line = content.slice(0, start).split('\n').length
      results.push({ text: content.slice(start, end), start, end, line })
      searchFrom = end || idx + 1
    }
    if (results.length > 0) return results

    // 2. 去除尾部空白后匹配
    const normContent = EditFileTool._stripTrailingWs(content)
    const normOld = EditFileTool._stripTrailingWs(oldText)
    searchFrom = 0
    while ((idx = normContent.indexOf(normOld, searchFrom)) !== -1) {
      // 映射回原文：从对应行开始匹配
      const lineNum = normContent.slice(0, idx).split('\n').length
      const lineStart = normContent.lastIndexOf('\n', idx - 1) + 1
      const lineEndIdx = normContent.indexOf('\n', idx + normOld.length)
      const lineEnd = lineEndIdx === -1 ? normContent.length : lineEndIdx
      const actualEnd = Math.min(lineEnd, content.length)
      const actualText = content.slice(lineStart, actualEnd)
      results.push({ text: actualText, start: lineStart, end: actualEnd, line: lineNum })
      searchFrom = idx + (normOld.length || 1)
    }
    if (results.length > 0) return results

    // 3. 行级包含匹配（oldText 的每一行都在 content 的连续行中）
    const oldLines = oldText.split('\n').filter(l => l.trim() !== '')
    if (oldLines.length <= 10) {
      const contentLines = content.split('\n')
      for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
        const match = oldLines.every((ol, j) =>
          contentLines[i + j]?.includes(ol.trim())
        )
        if (match) {
          // 计算在原文中的起止
          let lineStart = 0
          for (let k = 0; k < i; k++) lineStart += (contentLines[k] ?? '').length + 1
          let lineEnd = lineStart
          for (let k = i; k < i + oldLines.length; k++) lineEnd += (contentLines[k] ?? '').length + 1
          const text = content.slice(lineStart, lineEnd)
          results.push({ text, start: lineStart, end: lineEnd, line: i + 1 })
          return results
        }
      }
    }

    return []
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    try {
      const path = args.path as string | undefined
      if (!path) throw new Error('Unknown path')
      const oldText = args.old_text as string | undefined
      if (oldText === undefined) throw new Error('Unknown old_text')
      const newText = args.new_text as string | undefined
      if (newText === undefined) throw new Error('Unknown new_text')
      const replaceAll = (args.replace_all as boolean) ?? false

      const fp = this._resolve(path)

      // 创建文件语义：old_text='' 且文件不存在 → 创建
      if (!existsSync(fp)) {
        if (oldText === '') {
          const dir = dirname(fp)
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
          writeFileSync(fp, newText, 'utf-8')
          return `Successfully created ${fp}`
        }
        return `Error: File not found: ${path}`
      }

      const raw = readFileSync(fp, 'utf-8')
      const usesCrlf = raw.includes('\r\n')
      let content = raw.replace(/\r\n/g, '\n')
      const normOld = oldText.replace(/\r\n/g, '\n')

      const matches = EditFileTool._findMatch(content, normOld)

      if (matches.length === 0) {
        // 提供近似匹配提示
        return EditFileTool._notFoundMsg(oldText, content, path)
      }

      const count = matches.length
      if (count > 1 && !replaceAll) {
        const lineNums = matches.slice(0, 3).map(m => `line ${m.line}`).join(', ')
        const suffix = count > 3 ? ', ...' : ''
        return (
          `Warning: old_text appears ${count} times at ${lineNums}${suffix}. ` +
          'Provide more context to make it unique, or set replace_all=true.'
        )
      }

      let newTextNorm = newText.replace(/\r\n/g, '\n')
      // 非 markdown 文件去除尾部空白
      if (!['.md', '.mdx', '.markdown'].includes(extname(fp).toLowerCase())) {
        newTextNorm = EditFileTool._stripTrailingWs(newTextNorm)
      }

      const selected = replaceAll ? matches : matches.slice(0, 1)
      let newContent = content
      // 从后往前替换，保持位置偏移正确
      for (let i = selected.length - 1; i >= 0; i--) {
        const m = selected[i]!
        // 删除行清理：替换为空时，吃掉后面的换行
        let end = m.end
        if (newTextNorm === '' && !m.text.endsWith('\n') && content[end] === '\n') {
          end += 1
        }
        newContent = newContent.slice(0, m.start) + newTextNorm + newContent.slice(end)
      }

      // 恢复 CRLF
      if (usesCrlf) {
        newContent = newContent.replace(/\n/g, '\r\n')
      }

      writeFileSync(fp, newContent, 'utf-8')
      return `Successfully edited ${fp}`
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('outside allowed directory')) return `Error: ${msg}`
      return `Error editing file: ${msg}`
    }
  }

  private static _notFoundMsg(oldText: string, content: string, path: string): string {
    // 找到最接近的匹配窗口
    const oldLines = oldText.split('\n').filter(l => l.trim() !== '')
    const contentLines = content.split('\n')
    let bestRatio = 0
    let bestStart = 0

    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      let matchCount = 0
      for (let j = 0; j < oldLines.length; j++) {
        const o = (oldLines[j] ?? '').trim().toLowerCase()
        const c = contentLines[i + j]?.trim().toLowerCase() ?? ''
        if (o === c || (o && c && (c.includes(o) || o.includes(c)))) {
          matchCount++
        }
      }
      const ratio = oldLines.length > 0 ? matchCount / oldLines.length : 0
      if (ratio > bestRatio) {
        bestRatio = ratio
        bestStart = i
      }
    }

    if (bestRatio > 0.5) {
      const window = contentLines.slice(bestStart, bestStart + oldLines.length + 2)
      return (
        `Error: old_text not found in ${path}. ` +
        `Best match (${(bestRatio * 100).toFixed(0)}% similar) at line ${bestStart + 1}:\n` +
        window.map((l, i) => `${bestStart + i + 1}|${l}`).join('\n') +
        '\n\nCopy the exact text from read_file output and try again.'
      )
    }

    return `Error: old_text not found in ${path}. No similar text found. Verify the file content.`
  }
}

// ---- ListDirTool ----

export class ListDirTool extends FsTool {
  readonly name = 'list_dir'
  readonly description =
    'List the contents of a directory. ' +
    'Set recursive=true to explore nested structure. ' +
    'Common noise directories (.git, node_modules, __pycache__, etc.) are auto-ignored.'
  readonly parameters = defineParams({
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The directory path to list' },
      recursive: { type: 'boolean', description: 'Recursively list all files (default false)' },
      max_entries: { type: 'integer', description: 'Maximum entries to return (default 200)', minimum: 1 },
    },
    required: ['path'],
  })

  private static readonly DEFAULT_MAX = 200
  private static readonly IGNORE_DIRS = new Set([
    '.git', 'node_modules', '__pycache__', '.venv', 'venv',
    'dist', 'build', '.tox', '.mypy_cache', '.pytest_cache',
    '.ruff_cache', '.coverage', 'htmlcov',
  ])

  async execute(args: Record<string, unknown>): Promise<string> {
    try {
      const path = args.path as string | undefined
      if (path === undefined) throw new Error('Unknown path')

      const recursive = (args.recursive as boolean) ?? false
      const cap = Math.max(1, (args.max_entries as number | undefined) ?? ListDirTool.DEFAULT_MAX)

      const dp = this._resolve(path)
      if (!existsSync(dp)) return `Error: Directory not found: ${path}`

      try {
        const st = statSync(dp)
        if (!st.isDirectory()) return `Error: Not a directory: ${path}`
      } catch {
        return `Error: Directory not found: ${path}`
      }

      const items: string[] = []
      let total = 0

      if (recursive) {
        const totalRef = { count: 0 }
        this._walkRecursive(dp, dp, cap, items, totalRef)
        total = totalRef.count
      } else {
        const entries = readdirSync(dp, { withFileTypes: true })
        for (const entry of entries) {
          if (ListDirTool.IGNORE_DIRS.has(entry.name)) continue
          total++
          if (items.length < cap) {
            const prefix = entry.isDirectory() ? '[D] ' : '[F] '
            items.push(prefix + entry.name)
          }
        }
      }
      if (!items && total === 0) return `Directory ${path} is empty`

      let result = items.join('\n')
      if (total > cap) {
        result += `\n\n(truncated, showing first ${cap} of ${total} entries)`
      }
      return result
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('outside allowed directory')) return `Error: ${msg}`
      return `Error listing directory: ${msg}`
    }
  }

  private _walkRecursive(
    root: string,
    dir: string,
    cap: number,
    items: string[],
    totalRef: { count: number },
  ): void {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (ListDirTool.IGNORE_DIRS.has(entry.name)) continue
      totalRef.count++
      if (items.length < cap) {
        const rel = relative(root, join(dir, entry.name))
        if (entry.isDirectory()) {
          items.push(rel + '/')
          this._walkRecursive(root, join(dir, entry.name), cap, items, totalRef)
        } else {
          items.push(rel)
        }
      }
    }
  }
}
