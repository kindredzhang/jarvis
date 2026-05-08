/**
 * Sandbox backends for shell command execution.
 *
 * Port of original Python project.
 * To add a new backend, add a function and register it in _BACKENDS.
 */

import { execSync } from 'node:child_process'

function bwrap(command: string, workspace: string, cwd: string): string {
  const ws = workspace.replace(/\/$/, '')
  const mediaDir = joinWs(ws, 'media')

  // Determine sandbox cwd relative to workspace
  let sandboxCwd = ws
  if (cwd.startsWith(ws)) {
    sandboxCwd = cwd
  }

  const required = ['/usr']
  const optional = [
    '/bin', '/lib', '/lib64', '/etc/alternatives',
    '/etc/ssl/certs', '/etc/resolv.conf', '/etc/ld.so.cache',
  ]

  const args: string[] = ['bwrap', '--new-session', '--die-with-parent']
  for (const p of required) args.push('--ro-bind', p, p)
  for (const p of optional) args.push('--ro-bind-try', p, p)
  args.push(
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--tmpfs', ws.replace(/\/[^/]+$/, ''),   // mask parent dir (config)
    '--dir', ws,                               // recreate workspace mount point
    '--bind', ws, ws,
    '--ro-bind-try', mediaDir, mediaDir,
    '--chdir', sandboxCwd,
    '--', 'sh', '-c', command,
  )
  return args.map((a) => (a.includes(' ') ? `'${a}'` : a)).join(' ')
}

function joinWs(ws: string, sub: string): string {
  return `${ws}/${sub}`
}

const _BACKENDS: Record<string, (cmd: string, ws: string, cwd: string) => string> = {
  bwrap,
}

/**
 * Wrap *command* using the named sandbox backend.
 * Returns the wrapped command string, or throws if the backend is unknown.
 */
export function wrapCommand(sandbox: string, command: string, workspace: string, cwd: string): string {
  const backend = _BACKENDS[sandbox]
  if (backend) {
    return backend(command, workspace, cwd)
  }
  throw new Error(`Unknown sandbox backend '${sandbox}'. Available: ${Object.keys(_BACKENDS)}`)
}

/**
 * Check if a sandbox backend is available on the system.
 */
export function isSandboxAvailable(sandbox: string): boolean {
  if (!_BACKENDS[sandbox]) return false
  try {
    execSync(`which ${sandbox}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** List all registered backends. */
export function listBackends(): string[] {
  return Object.keys(_BACKENDS)
}
