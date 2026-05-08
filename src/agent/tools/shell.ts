/**
 * ExecTool —— shell 命令执行工具
 *
 * ========= TODO: 与 Python 原版差异标注 =========
 * 以下功能待移植（Python 原版 shell.py）：
 * - sandbox 沙箱支持（wrap_command）
 * - 内部/私有 URL 检测（contains_internal_url）
 * - 工作空间外路径检测（media_path / get_media_dir）
 * - Windows 多环境变量透传（SYSTEMROOT, HOMEDRIVE 等）
 * - bash -l 交互式登录 shell（当前用 /bin/bash -c）
 * - PATH 追加（path_append）
 * - asyncio 进程互联（当前用 Bun.spawn）
 * - 进程优雅终止（SIGTERM → SIGKILL → wait）
 */

import { Tool, defineParams } from './base'

const IS_WIN = process.platform === 'win32'

// ---- 危险命令模式（deny list） ----

const DEFAULT_DENY_PATTERNS: RegExp[] = [
  /\brm\s+-[rf]{1,2}\b/,
  /(?:^|[;&|]\s*)format\b/,
  /\b(mkfs|diskpart)\b/,
  /\bdd\s+if=/,
  />\s*\/dev\/sd/,
  /\b(shutdown|reboot|poweroff)\b/,
  /:\(\)\s*\{.*\};\s*:/,
  // Block writes to memory/history files
  />\S*(?:history\.jsonl|\.dream_cursor)/,
  /\btee\b[^|;&<>]*(?:history\.jsonl|\.dream_cursor)/,
  /\b(?:cp|mv)\b(?:\s+[^\s|;&<>]+)+\s+\S*(?:history\.jsonl|\.dream_cursor)/,
  /\bsed\s+-i[^|;&<>]*(?:history\.jsonl|\.dream_cursor)/,
]

export class ExecTool extends Tool {
  readonly name = 'exec'
  readonly description =
    'Execute a shell command and return its output. ' +
    'Prefer read/write/edit_file over cat/echo/sed, ' +
    'and grep/glob over shell find/grep. ' +
    'Output is truncated at 10 000 chars; timeout defaults to 60s.'
  readonly parameters = defineParams({
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute', minLength: 1 },
      working_dir: { type: 'string', description: 'Optional working directory for the command' },
      timeout: {
        type: 'integer',
        description: 'Timeout in seconds (default 60, max 600)',
        minimum: 1,
        maximum: 600,
      },
    },
    required: ['command'],
  })

  private timeout: number
  private workingDir: string | null
  private denyPatterns: RegExp[]
  private allowPatterns: RegExp[] | null
  private restrictToWorkspace: boolean
  private allowedEnvKeys: string[]

  private static readonly MAX_OUTPUT = 10_000
  private static readonly MAX_TIMEOUT = 600

  constructor(options?: {
    timeout?: number
    workingDir?: string | null
    denyPatterns?: RegExp[]
    allowPatterns?: RegExp[]
    restrictToWorkspace?: boolean
    allowedEnvKeys?: string[]
  }) {
    super()
    this.timeout = Math.min(options?.timeout ?? 60, ExecTool.MAX_TIMEOUT)
    this.workingDir = options?.workingDir ?? null
    this.denyPatterns = (options?.denyPatterns ?? []).concat(DEFAULT_DENY_PATTERNS)
    this.allowPatterns = options?.allowPatterns ?? null
    this.restrictToWorkspace = options?.restrictToWorkspace ?? false
    this.allowedEnvKeys = options?.allowedEnvKeys ?? []
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    try {
      const command = (args.command as string | undefined)?.trim()
      if (!command) return 'Error: No command provided'

      const workingDir = (args.working_dir as string | undefined) || this.workingDir || process.cwd()
      const timeout = Math.min(
        (args.timeout as number | undefined) ?? this.timeout,
        ExecTool.MAX_TIMEOUT,
      )

      // Safety guard
      const guardError = this._guardCommand(command, workingDir)
      if (guardError) return guardError

      // Build minimal environment
      const env = this._buildEnv()

      // Spawn and execute
      const shell = IS_WIN ? (process.env.COMSPEC || 'cmd.exe') : '/bin/bash'
      const shellArgs = IS_WIN ? ['/c', command] : ['-c', command]

      const proc = Bun.spawn([shell, ...shellArgs], {
        cwd: workingDir,
        env: env as Record<string, string>,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const result = await Promise.race([
        new Promise<{ stdout: string; stderr: string; exitCode: number }>(
          async (resolve, reject) => {
            try {
              const stdout = await new Response(proc.stdout).text()
              const stderr = await new Response(proc.stderr).text()
              const exitCode = await proc.exited
              resolve({ stdout, stderr, exitCode })
            } catch (err) {
              reject(err)
            }
          },
        ),
        (async () => {
          await Bun.sleep(timeout * 1000)
          proc.kill()
          throw new Error(`Command timed out after ${timeout} seconds`)
        })(),
      ])

      // Build output
      const parts: string[] = []
      if (result.stdout) {
        parts.push(result.stdout.replace(/\r\n/g, '\n'))
      }
      if (result.stderr?.trim()) {
        parts.push(`STDERR:\n${result.stderr.replace(/\r\n/g, '\n')}`)
      }
      parts.push(`\nExit code: ${result.exitCode}`)

      let output = parts.join('\n') || '(no output)'

      // Truncate
      if (output.length > ExecTool.MAX_OUTPUT) {
        const half = Math.floor(ExecTool.MAX_OUTPUT / 2)
        output =
          output.slice(0, half) +
          `\n\n... (${(output.length - ExecTool.MAX_OUTPUT).toLocaleString()} chars truncated) ...\n\n` +
          output.slice(-half)
      }

      return output
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('timed out') || msg.includes('timeout')) {
        return `Error: ${msg}`
      }
      return `Error executing command: ${msg}`
    }
  }

  // ---- Safety guard ----

  private _guardCommand(command: string, _cwd: string): string | null {
    const lower = command.toLowerCase()

    // Deny patterns
    for (const pattern of this.denyPatterns) {
      if (pattern.test(lower)) {
        return 'Error: Command blocked by safety guard (dangerous pattern detected)'
      }
    }

    // Allow patterns (if set, command must match at least one)
    if (this.allowPatterns) {
      const allowed = this.allowPatterns.some((p) => p.test(lower))
      if (!allowed) {
        return 'Error: Command blocked by safety guard (not in allowlist)'
      }
    }

    // Path traversal check
    if (this.restrictToWorkspace) {
      if (command.includes('../') || command.includes('..\\')) {
        return 'Error: Command blocked by safety guard (path traversal detected)'
      }
    }

    return null
  }

  // ---- Environment ----

  private _buildEnv(): Record<string, string> {
    const env: Record<string, string> = {}

    // Always pass HOME, PATH, LANG, TERM
    env.HOME = process.env.HOME || '/tmp'
    env.PATH = process.env.PATH || '/usr/bin:/bin'
    env.LANG = process.env.LANG || 'en_US.UTF-8'
    env.TERM = process.env.TERM || 'dumb'

    // Allowed extra keys
    for (const key of this.allowedEnvKeys) {
      const val = process.env[key]
      if (val) env[key] = val
    }

    return env
  }
}
