/**
 * Sync bundled templates to workspace directory.
 *
 * Port of original Python utils/helpers.py::sync_workspace_templates.
 * Copies missing template files from the project templates/ directory
 * into the user's workspace on first initialization.
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import chalk from 'chalk'
import { GitStore } from './gitstore'

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TEMPLATES_ROOT = join(PROJECT_ROOT, 'templates')

/**
 * Sync workspace template files from bundled templates.
 * Only creates files that do not already exist.
 * Returns list of relative paths that were created.
 */
export function syncWorkspaceTemplates(workspace: string, silent = false): string[] {
  const added: string[] = []

  if (!existsSync(TEMPLATES_ROOT)) return added

  // Root-level .md files (AGENTS.md, SOUL.md, USER.md, TOOLS.md, HEARTBEAT.md)
  const entries = readdirSync(TEMPLATES_ROOT)
  for (const name of entries) {
    const srcPath = join(TEMPLATES_ROOT, name)
    if (!name.endsWith('.md') || name.startsWith('.')) continue
    if (!statSync(srcPath).isFile()) continue
    const destPath = join(workspace, name)
    if (existsSync(destPath)) continue
    mkdirSync(dirname(destPath), { recursive: true })
    writeFileSync(destPath, readFileSync(srcPath, 'utf-8'), 'utf-8')
    added.push(name)
  }

  // templates/memory/MEMORY.md -> workspace/memory/MEMORY.md
  const tplMemory = join(TEMPLATES_ROOT, 'memory', 'MEMORY.md')
  const wsMemory = join(workspace, 'memory', 'MEMORY.md')
  if (existsSync(tplMemory) && !existsSync(wsMemory)) {
    mkdirSync(join(workspace, 'memory'), { recursive: true })
    writeFileSync(wsMemory, readFileSync(tplMemory, 'utf-8'), 'utf-8')
    added.push('memory/MEMORY.md')
  }

  // Empty memory/history.jsonl
  const historyPath = join(workspace, 'memory', 'history.jsonl')
  if (!existsSync(historyPath)) {
    mkdirSync(join(workspace, 'memory'), { recursive: true })
    writeFileSync(historyPath, '', 'utf-8')
    added.push('memory/history.jsonl')
  }

  // Ensure skills/ directory exists
  const skillsDir = join(workspace, 'skills')
  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true })
  }

  // Log created files
  if (added.length > 0 && !silent) {
    for (const name of added) {
      console.error(`  ${chalk.green('✓')} Created ${name}`)
    }
  }

  // Initialize git for memory version control
  try {
    const gs = new GitStore(workspace, [
      'SOUL.md',
      'USER.md',
      'memory/MEMORY.md',
    ])
    gs.init()
  } catch {
    // Git init failure is non-fatal
  }

  return added
}
