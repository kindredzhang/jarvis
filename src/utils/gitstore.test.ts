import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { GitStore } from './gitstore'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'jarvis-git-'))
})

afterEach(() => {
  try { rmSync(workspace, { recursive: true, force: true }) } catch {}
})

describe('GitStore', () => {
  test('isInitialized returns false before init', () => {
    const store = new GitStore(workspace)
    expect(store.isInitialized()).toBe(false)
  })

  test('init creates a git repo', () => {
    const store = new GitStore(workspace)
    const result = store.init()
    expect(result).toBe(true)
    expect(store.isInitialized()).toBe(true)
    expect(existsSync(join(workspace, '.git'))).toBe(true)
  })

  test('init creates tracked files', () => {
    const store = new GitStore(workspace)
    store.init()
    expect(existsSync(join(workspace, 'SOUL.md'))).toBe(true)
    expect(existsSync(join(workspace, 'USER.md'))).toBe(true)
    expect(existsSync(join(workspace, 'memory/MEMORY.md'))).toBe(true)
  })

  test('init creates .gitignore', () => {
    const store = new GitStore(workspace)
    store.init()
    const gitignore = readFileSync(join(workspace, '.gitignore'), 'utf-8')
    expect(gitignore).toContain('!SOUL.md')
    expect(gitignore).toContain('!USER.md')
    expect(gitignore).toContain('!memory/MEMORY.md')
  })

  test('second init returns false', () => {
    const store = new GitStore(workspace)
    expect(store.init()).toBe(true)
    expect(store.init()).toBe(false)
  })

  test('log returns initial commit', () => {
    const store = new GitStore(workspace)
    store.init()
    const commits = store.log()
    expect(commits.length).toBeGreaterThanOrEqual(1)
    expect(commits[0].message).toContain('init')
  })

  test('autoCommit creates a commit when file changes', () => {
    const store = new GitStore(workspace)
    store.init()
    writeFileSync(join(workspace, 'SOUL.md'), 'Updated soul', 'utf-8')
    const sha = store.autoCommit('update: SOUL.md')
    expect(sha).not.toBeNull()
    expect(sha!.length).toBeGreaterThanOrEqual(6)

    const commits = store.log()
    expect(commits.length).toBeGreaterThanOrEqual(2)
    expect(commits[0].message).toContain('update')
  })

  test('autoCommit returns null when no changes', () => {
    const store = new GitStore(workspace)
    store.init()
    const sha = store.autoCommit('no changes')
    expect(sha).toBeNull()
  })

  test('log returns commits in reverse order', () => {
    const store = new GitStore(workspace)
    store.init()
    writeFileSync(join(workspace, 'SOUL.md'), 'v1', 'utf-8')
    store.autoCommit('first change')
    writeFileSync(join(workspace, 'SOUL.md'), 'v2', 'utf-8')
    store.autoCommit('second change')

    const commits = store.log(10)
    expect(commits.length).toBeGreaterThanOrEqual(3)
    expect(commits[0].message).toContain('second')
    expect(commits[1].message).toContain('first')
  })

  test('showCommitDiff returns diff', () => {
    const store = new GitStore(workspace)
    store.init()
    writeFileSync(join(workspace, 'SOUL.md'), 'Changed content', 'utf-8')
    store.autoCommit('a change')

    const commits = store.log()
    const result = store.showCommitDiff(commits[0].sha)
    expect(result).not.toBeNull()
    const [info, diff] = result!
    expect(info.message).toContain('change')
    expect(diff).toContain('Changed content')
  })

  test('revert restores previous state', () => {
    const store = new GitStore(workspace)
    store.init()
    
    // Write v1 and commit
    writeFileSync(join(workspace, 'SOUL.md'), 'version 1', 'utf-8')
    store.autoCommit('v1')
    
    // Write v2 and commit
    writeFileSync(join(workspace, 'SOUL.md'), 'version 2', 'utf-8')
    store.autoCommit('v2')

    // Revert v2
    const commits = store.log()
    const revertSha = store.revert(commits[0].sha)
    expect(revertSha).not.toBeNull()

    // Verify content is back to v1
    const content = readFileSync(join(workspace, 'SOUL.md'), 'utf-8')
    expect(content).toContain('version 1')
  })
})
