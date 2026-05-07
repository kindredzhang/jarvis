/**
 * 搜索工具 —— glob 文件查找 + grep 内容正则搜索
 *
 * ========= TODO: 与 nanobot 差异标注 =========
 * 以下在 nanobot/agent/tools/search.py 中存在，本文件暂未实现：
 * - file_type 过滤（_TYPE_GLOB_MAP 按语言类型筛选）
 * - entry_type="both"/"dirs"（GlobTool 同时匹配目录）
 * - max_matches / max_results 别名参数
 * - _is_binary 二进制文件检测
 * - _MAX_FILE_BYTES 文件大小保护（2 MB）
 * - output_mode="count"（grep 只输出匹配行数）
 * - context_before / context_after（grep 上下文行）
 * - fixed_strings（grep 将模式视为纯文本）
 * - 按 mtime 排序结果
 */

import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { Tool, defineParams } from './base'

// ---- 共享搜索基类 ----

const IGNORE_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'venv',
  'dist', 'build', '.tox', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', '.coverage', 'htmlcov',
])

/** 将相对路径对齐到 workspace */
function resolveSearchPath(
  path: string,
  workspace: string | undefined,
  allowedDir: string | null | undefined,
): string {
  if (path.startsWith('/')) return path
  if (workspace) return join(workspace, path)
  if (allowedDir) return join(allowedDir, path)
  return path
}

/** 递归遍历文件（跳过噪声目录） */
function* walkFiles(root: string, includeDirs = false): Generator<string> {
  try {
    const st = statSync(root)
    if (st.isFile()) {
      yield root
      return
    }
  } catch {
    return
  }

  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (IGNORE_DIRS.has(entry.name)) continue
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (includeDirs) yield fullPath
          stack.push(fullPath)
        } else {
          yield fullPath
        }
      }
    } catch {
      // skip unreadable directories
    }
  }
}

/** 简单的 glob 匹配 —— 支持 *、? 和 ** */
function globMatch(filePath: string, fileName: string, pattern: string): boolean {
  const p = pattern.replace(/\\/g, '/')
  if (!p) return false
  // 如果包含 / 或 **，匹配完整路径
  if (p.includes('/') || p.startsWith('**')) {
    return minimatchLike(filePath, p)
  }
  // 否则只匹配文件名
  return minimatchLike(fileName, p)
}

/** 简化的 glob 实现（支持 *、?、[abc]、**） */
function minimatchLike(path: string, pattern: string): boolean {
  // 将 glob 模式转换为正则
  let regex = ''
  let i = 0
  const p = pattern
  while (i < p.length) {
    const ch = p[i]
    if (ch === '*') {
      if (i + 1 < p.length && p[i + 1] === '*') {
        // ** 匹配任意路径（包括 /）
        regex += '.*'
        i += 2
        // 跳过紧随其后的 /
        if (i < p.length && p[i] === '/') i++
      } else {
        // * 匹配除 / 外的任意字符
        regex += '[^/]*'
        i++
      }
    } else if (ch === '?') {
      regex += '[^/]'
      i++
    } else if (ch === '.') {
      regex += '\\.'
      i++
    } else if (ch === '+') {
      regex += '\\+'
      i++
    } else if (ch === '(') {
      regex += '\\('
      i++
    } else if (ch === ')') {
      regex += '\\)'
      i++
    } else if (ch === '{') {
      // 处理 {a,b,c} 花括号展开
      let end = p.indexOf('}', i)
      if (end === -1) {
        regex += '\\{'
        i++
      } else {
        const options = p.slice(i + 1, end).split(',').map(s => s.replace(/[.+?*(){}[\]\\^$|]/g, '\\$&'))
        regex += '(?:' + options.join('|') + ')'
        i = end + 1
      }
    } else if (ch === '[') {
      let end = p.indexOf(']', i)
      if (end === -1) {
        regex += '\\['
        i++
      } else {
        regex += p.slice(i, end + 1)
        i = end + 1
      }
    } else {
      regex += (ch ?? '').replace(/[.+?*(){}[\]\\^$|]/g, '\\$&')
      i++
    }
  }
  return new RegExp('^' + regex + '$').test(path)
}

// ---- GlobTool ----

export class GlobTool extends Tool {
  readonly name = 'glob'
  readonly description =
    "Find files matching a glob pattern (e.g. '*.py', 'tests/**/test_*.py'). " +
    "Skips .git, node_modules, __pycache__, and other noise directories."
  readonly parameters = defineParams({
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: "Glob pattern to match, e.g. '*.py' or 'tests/**/test_*.py'",
        minLength: 1,
      },
      path: {
        type: 'string',
        description: "Directory to search from (default '.')",
      },
      head_limit: {
        type: 'integer',
        description: "Maximum number of matches to return (default 250)",
        minimum: 0,
      },
      offset: {
        type: 'integer',
        description: "Skip the first N matching entries before returning results",
        minimum: 0,
      },
    },
    required: ['pattern'],
  })

  private static readonly DEFAULT_LIMIT = 250

  async execute(args: Record<string, unknown>): Promise<string> {
    try {
      const pattern = args.pattern as string
      const searchPath = (args.path as string) || '.'
      const headLimit = (args.head_limit as number | undefined) ?? GlobTool.DEFAULT_LIMIT
      const offset = (args.offset as number | undefined) ?? 0

      const root = resolveSearchPath(searchPath, undefined, null)
      if (!existsSync(root)) return `Error: Path not found: ${searchPath}`

      try {
        if (!statSync(root).isDirectory()) return `Error: Not a directory: ${searchPath}`
      } catch {
        return `Error: Not a directory: ${searchPath}`
      }

      const matches: string[] = []
      let total = 0

      for (const file of walkFiles(root)) {
        const relPath = relative(root, file).replace(/\\/g, '/')
        const fileName = file.split('/').pop() ?? ''
        if (globMatch(relPath, fileName, pattern)) {
          total++
          if (total > offset && matches.length < headLimit) {
            matches.push(relPath)
          }
        }
      }

      if (total === 0) {
        return `No paths matched pattern '${pattern}' in ${searchPath}`
      }

      let result = matches.join('\n')
      if (total > offset + headLimit) {
        result += `\n\n(pagination: limit=${headLimit}, offset=${offset})`
      }
      return result
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return `Error finding files: ${msg}`
    }
  }
}

// ---- GrepTool ----

export class GrepTool extends Tool {
  readonly name = 'grep'
  readonly description =
    "Search file contents with a regex pattern. " +
    "Returns matching file paths by default. " +
    "Skips binary and large files. Supports glob filtering and case-insensitive search."
  readonly parameters = defineParams({
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: "Regex or plain text pattern to search for",
        minLength: 1,
      },
      path: {
        type: 'string',
        description: "File or directory to search in (default '.')",
      },
      glob: {
        type: 'string',
        description: "Optional file filter, e.g. '*.py' or 'tests/**/test_*.py'",
      },
      case_insensitive: {
        type: 'boolean',
        description: "Case-insensitive search (default false)",
      },
      output_mode: {
        type: 'string',
        description: "content: matching lines; files_with_matches: file paths only. Default: files_with_matches",
        enum: ['content', 'files_with_matches'],
      },
      head_limit: {
        type: 'integer',
        description: "Maximum number of results to return (default 250)",
        minimum: 0,
      },
      offset: {
        type: 'integer',
        description: "Skip the first N results before applying head_limit",
        minimum: 0,
      },
    },
    required: ['pattern'],
  })

  private static readonly DEFAULT_LIMIT = 250
  private static readonly MAX_FILE_BYTES = 2_000_000
  private static readonly MAX_RESULT_CHARS = 128_000

  /** 检查是否为二进制文件 */
  private static _isBinary(raw: Uint8Array): boolean {
    if (raw.length === 0) return false
    // 检查空字节
    for (let i = 0; i < Math.min(raw.length, 8192); i++) {
      if (raw[i] === 0) return true
    }
    return false
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    try {
      const pattern = args.pattern as string
      const searchPath = (args.path as string) || '.'
      const globFilter = (args.glob as string | undefined) ?? null
      const caseInsensitive = (args.case_insensitive as boolean) ?? false
      const outputMode = (args.output_mode as string | undefined) ?? 'files_with_matches'
      const headLimit = (args.head_limit as number | undefined) ?? GrepTool.DEFAULT_LIMIT
      const offset = (args.offset as number | undefined) ?? 0

      const target = resolveSearchPath(searchPath, undefined, null)
      if (!existsSync(target)) return `Error: Path not found: ${searchPath}`

      // 编译正则
      let regex: RegExp
      try {
        regex = new RegExp(pattern, caseInsensitive ? 'gi' : 'g')
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return `Error: invalid regex pattern: ${msg}`
      }

      const isFile = existsSync(target) && statSync(target).isFile()
      const root = isFile ? target.split('/').slice(0, -1).join('/') || '.' : target

      const matchingFiles: { path: string; count: number }[] = []
      const contentBlocks: string[] = []
      let resultChars = 0
      let seenMatches = 0
      let totalFilesSearched = 0
      let skippedBinary = 0
      let skippedLarge = 0
      let truncated = false

      const files = isFile ? [target] : [...walkFiles(target)]

      for (const filePath of files) {
        const relPath = relative(root, filePath).replace(/\\/g, '/')
        const fileName = filePath.split('/').pop() ?? ''

        // glob 过滤
        if (globFilter && !globMatch(relPath, fileName, globFilter)) continue

        totalFilesSearched++

        // 文件大小检查
        let fsize: number
        try {
          fsize = statSync(filePath).size
        } catch {
          continue
        }
        if (fsize > GrepTool.MAX_FILE_BYTES) {
          skippedLarge++
          continue
        }

        // 二进制检查
        let raw: Buffer
        try {
          raw = readFileSync(filePath)
        } catch {
          continue
        }
        if (GrepTool._isBinary(new Uint8Array(raw))) {
          skippedBinary++
          continue
        }

        let content: string
        try {
          content = raw.toString('utf-8')
        } catch {
          skippedBinary++
          continue
        }

        const lines = content.split('\n')
        let fileHadMatch = false

        for (let idx = 0; idx < lines.length; idx++) {
          const line = lines[idx]
          regex.lastIndex = 0
          if (!line || !regex.test(line)) continue

          fileHadMatch = true

          if (outputMode === 'files_with_matches') {
            if (!matchingFiles.some(m => m.path === relPath)) {
              matchingFiles.push({ path: relPath, count: 0 })
            }
            break // 文件有匹配就够
          }

          // content mode
          seenMatches++
          if (seenMatches <= offset) continue
          if (contentBlocks.length >= headLimit) {
            truncated = true
            break
          }

          const lineNum = idx + 1
          const block = `${relPath}:${lineNum}\n> ${lineNum}| ${line}`
          const extraSep = contentBlocks.length > 0 ? 2 : 0
          if (resultChars + extraSep + block.length > GrepTool.MAX_RESULT_CHARS) {
            truncated = true
            break
          }
          contentBlocks.push(block)
          resultChars += extraSep + block.length
        }

        if (fileHadMatch && outputMode === 'files_with_matches') continue
        if (truncated) break
      }

      // 构建结果
      let result: string

      if (outputMode === 'files_with_matches') {
        if (matchingFiles.length === 0) {
          result = `No matches found for pattern '${pattern}' in ${searchPath}`
        } else {
          const paged = matchingFiles.slice(offset, offset + headLimit)
          result = paged.map(m => m.path).join('\n')
          if (matchingFiles.length > offset + headLimit) {
            result += `\n\n(pagination: limit=${headLimit}, offset=${offset})`
          }
        }
      } else {
        // content mode
        if (contentBlocks.length === 0) {
          result = `No matches found for pattern '${pattern}' in ${searchPath}`
        } else {
          result = contentBlocks.join('\n\n')
          if (truncated) {
            result += `\n\n(pagination: limit=${headLimit}, offset=${offset})`
          }
        }
      }

      // 附注
      const notes: string[] = []
      if (skippedBinary > 0) notes.push(`(skipped ${skippedBinary} binary files)`)
      if (skippedLarge > 0) notes.push(`(skipped ${skippedLarge} large files)`)
      if (outputMode === 'content' && contentBlocks.length > 0) {
        notes.push(`(found ${seenMatches} matches in ${matchingFiles.length} files)`)
      }
      if (notes.length > 0) result += '\n\n' + notes.join('\n')

      return result
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return `Error searching files: ${msg}`
    }
  }
}
