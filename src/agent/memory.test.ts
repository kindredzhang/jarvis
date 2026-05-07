import { test, expect, beforeEach, afterEach } from 'bun:test'
import { MemoryStore, type HistoryRecord } from './memory'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let workspace: string
let store: MemoryStore

beforeEach(() => {
  workspace = join(tmpdir(), 'jarvis-test-' + Math.random().toString(36).slice(2, 8))
  // 确保上一轮清理干净
  if (existsSync(workspace)) rmSync(workspace, { recursive: true })
  store = new MemoryStore(workspace, 5) // 小上限用于测试压缩
})

afterEach(() => {
  if (existsSync(workspace)) {
    rmSync(workspace, { recursive: true })
  }
})

// ============ 文件 I/O ============

test('readMemory returns empty when file does not exist', () => {
  expect(store.readMemory()).toBe('')
})

test('writeMemory and readMemory round-trip', () => {
  store.writeMemory('记住：用户叫 Alice')
  expect(store.readMemory()).toBe('记住：用户叫 Alice')
})

test('readSoul and readUser return empty when files do not exist', () => {
  expect(store.readSoul()).toBe('')
  expect(store.readUser()).toBe('')
})

test('writeSoul and writeUser persist content', () => {
  store.writeSoul('# 我是一个友善的助手')
  store.writeUser('# 用户偏好：中文')
  expect(store.readSoul()).toBe('# 我是一个友善的助手')
  expect(store.readUser()).toBe('# 用户偏好：中文')
})

// ============ 记忆上下文 ============

test('getMemoryContext returns empty when no memory', () => {
  expect(store.getMemoryContext()).toBe('')
})

test('getMemoryContext wraps memory in section header', () => {
  store.writeMemory('重要事实')
  expect(store.getMemoryContext()).toBe('## Long-term Memory\n重要事实')
})

// ============ 历史追加 ============

test('appendHistory returns auto-incrementing cursors', () => {
  const c1 = store.appendHistory('第一个条目')
  const c2 = store.appendHistory('第二个条目')
  expect(c1).toBe(1)
  expect(c2).toBe(2)
})

test('appendHistory persists records to JSONL', () => {
  store.appendHistory('hello world')
  const entries = JSONL.readAll<HistoryRecord>(store.historyFile)
  expect(entries).toHaveLength(1)
  expect(entries[0].content).toBe('hello world')
  expect(entries[0].cursor).toBe(1)
  expect(typeof entries[0].timestamp).toBe('string')
})

test('appendHistory strips think tags from content', () => {
  store.appendHistory('action: done')
  const entries = JSONL.readAll<HistoryRecord>(store.historyFile)
  expect(entries[0].content).toBe('action: done')
})

test('appendHistory cursor persists across restarts', () => {
  store.appendHistory('entry 1')
  store.appendHistory('entry 2')

  // 创建新的 MemoryStore 指向同一个 workspace
  const store2 = new MemoryStore(workspace, 5)
  const c3 = store2.appendHistory('entry 3')
  expect(c3).toBe(3)
})

// ============ 历史读取 ============

test('readUnprocessedHistory filters by cursor', () => {
  store.appendHistory('a')
  store.appendHistory('b')
  store.appendHistory('c')

  const unprocessed = store.readUnprocessedHistory(1)
  expect(unprocessed).toHaveLength(2)
  expect(unprocessed[0].content).toBe('b')
  expect(unprocessed[1].content).toBe('c')
})

test('readUnprocessedHistory returns empty for no new entries', () => {
  store.appendHistory('a')
  expect(store.readUnprocessedHistory(1)).toEqual([])
})

// ============ 历史压缩 ============

test('compactHistory keeps only newest entries', () => {
  // 上限是 5 → 追加 7 条后压缩只保留 5 条
  for (let i = 1; i <= 7; i++) {
    store.appendHistory('entry ' + i)
  }
  store.compactHistory()

  const entries = JSONL.readAll<HistoryRecord>(store.historyFile)
  expect(entries).toHaveLength(5)
  expect(entries[0].content).toBe('entry 3')
  expect(entries[4].content).toBe('entry 7')
})

test('compactHistory does nothing when under limit', () => {
  for (let i = 1; i <= 3; i++) {
    store.appendHistory('entry ' + i)
  }
  store.compactHistory()

  const entries = JSONL.readAll<HistoryRecord>(store.historyFile)
  expect(entries).toHaveLength(3)
})

test('compactHistory with maxHistoryEntries=0 never compacts', () => {
  const noCompact = new MemoryStore(join(workspace, 'no-compact'), 0)
  for (let i = 1; i <= 100; i++) {
    noCompact.appendHistory('entry ' + i)
  }
  noCompact.compactHistory()

  const entries = JSONL.readAll<HistoryRecord>(noCompact.historyFile)
  expect(entries).toHaveLength(100)
})

// ============ Dream 游标 ============

test('getLastDreamCursor defaults to 0', () => {
  expect(store.getLastDreamCursor()).toBe(0)
})

test('setLastDreamCursor and getLastDreamCursor round-trip', () => {
  store.setLastDreamCursor(42)
  expect(store.getLastDreamCursor()).toBe(42)
})

// ============ 文件结构 ============

test('creates memory directory on construction', () => {
  expect(existsSync(store.memoryDir)).toBe(true)
})

test('file paths are correct', () => {
  expect(store.memoryFile).toBe(join(workspace, 'memory', 'MEMORY.md'))
  expect(store.historyFile).toBe(join(workspace, 'memory', 'history.jsonl'))
  expect(store.soulFile).toBe(join(workspace, 'SOUL.md'))
  expect(store.userFile).toBe(join(workspace, 'USER.md'))
})

// ============ JSONL 工具 ============

import { JSONL } from '../utils/jsonl'

test('JSONL readAll returns empty array for nonexistent file', () => {
  const result = JSONL.readAll<Record<string, unknown>>('/nonexistent/path.jsonl')
  expect(result).toEqual([])
})

test('JSONL readAll parses valid entries', () => {
  const path = join(workspace, 'test.jsonl')
  JSONL.writeAll(path, [
    { a: 1, b: 'x' },
    { a: 2, b: 'y' },
  ])
  const result = JSONL.readAll<{ a: number; b: string }>(path)
  expect(result).toHaveLength(2)
  expect(result[0].a).toBe(1)
  expect(result[1].a).toBe(2)
})

test('JSONL append adds to file', () => {
  const path = join(workspace, 'append.jsonl')
  JSONL.append(path, { id: 1, value: 'first' })
  JSONL.append(path, { id: 2, value: 'second' })
  const result = JSONL.readAll<{ id: number; value: string }>(path)
  expect(result).toHaveLength(2)
  expect(result[1].id).toBe(2)
})

test('JSONL readLast returns last entry', () => {
  const path = join(workspace, 'last.jsonl')
  JSONL.writeAll(path, [
    { id: 1, name: 'a' },
    { id: 2, name: 'b' },
    { id: 3, name: 'c' },
  ])
  const last = JSONL.readLast<{ id: number; name: string }>(path)
  expect(last).not.toBeNull()
  expect(last!.id).toBe(3)
})

test('JSONL readLast returns null for empty file', () => {
  const path = join(workspace, 'empty.jsonl')
  JSONL.writeAll(path, [])
  const last = JSONL.readLast<Record<string, unknown>>(path)
  expect(last).toBeNull()
})
