/**
 * Runtime path helpers — port of original Python project
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { getConfigPath } from './loader'

function ensureDir(path: string): string {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true })
  }
  return path
}

export function getDataDir(): string {
  return ensureDir(
    getConfigPath().substring(0, getConfigPath().lastIndexOf('/')) ||
      join(homedir(), '.jarvis'),
  )
}

export function getRuntimeSubdir(name: string): string {
  return ensureDir(join(getDataDir(), name))
}

export function getMediaDir(channel?: string): string {
  const base = getRuntimeSubdir('media')
  return channel ? ensureDir(join(base, channel)) : base
}

export function getCronDir(): string {
  return getRuntimeSubdir('cron')
}

export function getLogsDir(): string {
  return getRuntimeSubdir('logs')
}

export function getWorkspacePath(workspace?: string): string {
  const path = workspace
    ? workspace.replace(/^~/, homedir())
    : join(homedir(), '.jarvis')
  return ensureDir(path)
}

export function isDefaultWorkspace(workspace?: string): boolean {
  const current = workspace
    ? workspace.replace(/^~/, homedir())
    : join(homedir(), '.jarvis')
  const def = join(homedir(), '.jarvis')
  return current === def
}

export function getCliHistoryPath(): string {
  return join(homedir(), '.jarvis', 'history', 'cli_history')
}

export function getLegacySessionsDir(): string {
  return join(homedir(), '.jarvis', 'sessions')
}
