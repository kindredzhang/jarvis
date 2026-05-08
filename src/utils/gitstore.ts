/**
 * GitStore —— Git 版本管理（基于 git CLI）
 *
 * 管理记忆文件的版本历史，支持：
 * - init / auto_commit / log / diff / revert / line_ages
 *
 * ========= TODO: 与 nanobot 差异标注 =========
 * - 基于 git CLI 而非 dulwich 库
 * - 无 _resolve_sha 精确前缀匹配（直接精确匹配）
 * - 无 _is_inside_git_repo 检查
 * - 无 dulwich 的 tree/blob 直接读取
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

export interface CommitInfo {
  sha: string
  message: string
  timestamp: string
}

export interface LineAge {
  ageDays: number
}

const DEFAULT_TRACKED_FILES = [
  'SOUL.md',
  'USER.md',
  'memory/MEMORY.md',
  'memory/history.jsonl',
]

export class GitStore {
  private workspace: string
  private trackedFiles: string[]

  constructor(workspace: string, trackedFiles?: string[]) {
    this.workspace = workspace
    this.trackedFiles = trackedFiles ?? DEFAULT_TRACKED_FILES
  }

  private get gitDir(): string {
    return join(this.workspace, '.git')
  }

  isInitialized(): boolean {
    return existsSync(this.gitDir)
  }

  /** 初始化 git 仓库 + 首次提交 */
  init(): boolean {
    if (this.isInitialized()) return false

    // git init
    const r1 = this._git('init')
    if (r1.status !== 0) return false

    // 确保跟踪文件存在
    for (const rel of this.trackedFiles) {
      const fp = join(this.workspace, rel)
      if (!existsSync(fp)) {
        mkdirSync(fp.split('/').slice(0, -1).join('/') || this.workspace, { recursive: true })
        writeFileSync(fp, '', 'utf-8')
      }
    }

    // .gitignore
    const gitignore = this._buildGitignore()
    writeFileSync(join(this.workspace, '.gitignore'), gitignore, 'utf-8')

    // 首次提交
    this._git('add', ['.gitignore', ...this.trackedFiles])
    const r2 = this._git('commit', ['-m', 'init: jarvis memory store'])
    return r2.status === 0
  }

  /** 自动提交（仅当有变更时） */
  autoCommit(message: string): string | null {
    if (!this.isInitialized()) return null

    // 检查是否有变更
    this._git('add', ['--dry-run', ...this.trackedFiles])
    const dry = this._git('diff', ['--cached', '--name-only'])
    // 也检查未暂存的变更
    const unstaged = this._git('diff', ['--name-only'])
    if (!dry.stdout && !unstaged.stdout) return null

    this._git('add', this.trackedFiles)
    const r = this._git('commit', ['-m', message])
    if (r.status !== 0) return null

    // 获取最新 commit SHA
    const log = this._git('log', ['-1', '--format=%H'])
    const shaStr = log.stdout?.trim() ?? ''
    return shaStr.slice(0, 8) || null
  }

  /** 获取提交历史 */
  log(maxEntries = 20): CommitInfo[] {
    if (!this.isInitialized()) return []

    const r = this._git('log', [
      `--max-count=${maxEntries}`,
      '--format=%H||%s||%ci',
    ])
    if (r.status !== 0 || !r.stdout) return []

    return r.stdout.trim().split('\n').filter(Boolean).map((line) => {
      const lineParts = line.split('||')
      const sha = lineParts[0] ?? ''
      const msgParts = lineParts.slice(1)
      const msg = lineParts[1] ?? "" // message may contain ||
      const datePart = lineParts[2] ?? ''
      return {
        sha: sha.slice(0, 8),
        message: msg.trim(),
        timestamp: datePart.slice(0, 16).replace('T', ' '),
      }
    })
  }

  /** 获取两 commit 间的 diff */
  diffCommits(sha1: string, sha2: string): string {
    if (!this.isInitialized()) return ''
    const r = this._git('diff', [sha1 + '..' + sha2])
    return r.stdout?.trim() ?? ''
  }

  /** 获取某个 commit 与其父 commit 的 diff */
  showCommitDiff(shortSha: string): [CommitInfo, string] | null {
    const commits = this.log(20)
    for (let i = 0; i < commits.length; i++) {
      if (commits[i] && commits[i]!.sha.startsWith(shortSha)) {
        const diff = i + 1 < commits.length
          ? this.diffCommits(commits[i + 1]!.sha, commits[i]!.sha)
          : ''
        return [commits[i]!, diff]
      }
    }
    return null
  }

  /** 获取文件每行的最后修改距今的天数（git blame） */
  lineAges(filePath: string): LineAge[] {
    if (!this.isInitialized()) return []

    const fp = join(this.workspace, filePath)
    if (!existsSync(fp)) return []

    const r = this._git('blame', ['--porcelain', filePath], this.workspace)
    if (r.status !== 0 || !r.stdout) return []

    // Parse porcelain format: extract committer-time for each line
    const ages: LineAge[] = []
    const now = Date.now()
    const lines = r.stdout.split('\n')
    let i = 0
    // commit-times extracted per-line directly

    while (i < lines.length) {
      const line = lines[i]!
      if (!line || line.startsWith('\t')) {
        i++
        continue
      }

      const parts = line.split(' ')
      const sha = parts[0]!
      const lineNum = parseInt(parts[2] ?? '1', 10)

      // Skip header lines
      if (line.startsWith('author') || line.startsWith('committer') ||
          line.startsWith('summary') || line.startsWith('filename')) {
        i++
        continue
      }

      // Extract committer-time
      if (line.startsWith('committer-time ')) {
        const ts = parseInt(line.split(' ')[1]!, 10)
        const days = Math.floor((now - ts * 1000) / (1000 * 60 * 60 * 24))
        ages.push({ ageDays: days })
        i++
        continue
      }

      i++
    }

    return ages
  }

  /** 恢复某个 commit 前的状态（revert） */
  revert(commit: string): string | null {
    if (!this.isInitialized()) return null

    const commits = this.log(20)
    let targetIdx = -1
    for (let i = 0; i < commits.length; i++) {
      if (commits[i]!.sha.startsWith(commit)) {
        targetIdx = i
        break
      }
    }
    if (targetIdx === -1 || targetIdx + 1 >= commits.length) return null

    // 用父 commit 的 tree 恢复文件
    const parentSha = commits[targetIdx + 1]!
    for (const rel of this.trackedFiles) {
      const r = this._git('show', [`${parentSha!.sha}:${rel}`], this.workspace)
      if (r.status === 0 && r.stdout !== null) {
        writeFileSync(join(this.workspace, rel), r.stdout, 'utf-8')
      }
    }

    return this.autoCommit(`revert: undo ${commit}`)
  }

  // ---- 内部方法 ----

  private _git(
    cmd: string,
    args: string[] = [],
    cwd?: string,
  ): { status: number; stdout: string | null } {
    const fullArgs = ['-C', this.workspace, cmd, ...args]
    const result = spawnSync('git', fullArgs, {
      cwd: cwd ?? this.workspace,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    })
    return {
      status: result.status ?? -1,
      stdout: result.stdout ?? null,
    }
  }

  private _buildGitignore(): string {
    const dirs = new Set<string>()
    for (const f of this.trackedFiles) {
      const parent = f.split('/').slice(0, -1).join('/')
      if (parent) dirs.add(parent)
    }
    const lines = ['/*']
    for (const d of [...dirs].sort()) lines.push(`!${d}/`)
    for (const f of this.trackedFiles) lines.push(`!${f}`)
    lines.push('!.gitignore')
    return lines.join('\n') + '\n'
  }
}
