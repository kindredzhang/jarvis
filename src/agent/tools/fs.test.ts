import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { ReadFileTool, WriteFileTool, EditFileTool, ListDirTool } from './fs'
import { join } from 'node:path'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'jarvis-fs-test-'))
})

afterEach(() => {
  try {
    rmSync(workspace, { recursive: true, force: true })
  } catch {
    // ignore cleanup errors
  }
})

// ============ ReadFileTool ============

describe('ReadFileTool', () => {
  test('reads a simple file', async () => {
    const fp = join(workspace, 'hello.txt')
    writeFileSync(fp, 'Hello, World!\nLine 2\nLine 3', 'utf-8')

    const tool = new ReadFileTool(workspace)
    const result = await tool.execute({ path: 'hello.txt' } as any)
    expect(result).toContain('Hello, World!')
    expect(result).toContain('Line 2')
    expect(result).toContain('Line 3')
    expect(result).toContain('End of file')
  })

  test('supports offset and limit', async () => {
    const fp = join(workspace, 'lines.txt')
    const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join('\n')
    writeFileSync(fp, lines, 'utf-8')

    const tool = new ReadFileTool(workspace)
    const result = await tool.execute({ path: 'lines.txt', offset: 5, limit: 3 } as any)
    expect(result).toContain('5|Line 5')
    expect(result).toContain('6|Line 6')
    expect(result).toContain('7|Line 7')
    expect(result).not.toContain('Line 8')
    expect(result).toContain('Showing lines 5-7 of 20')
  })

  test('returns error for non-existent file', async () => {
    const tool = new ReadFileTool(workspace)
    const result = await tool.execute({ path: 'nonexistent.txt' } as any)
    expect(result).toContain('File not found')
  })

  test('returns error for directory', async () => {
    mkdirSync(join(workspace, 'subdir'))
    const tool = new ReadFileTool(workspace)
    const result = await tool.execute({ path: 'subdir' } as any)
    expect(result).toContain('Not a file')
  })

  test('returns error for empty path', async () => {
    const tool = new ReadFileTool(workspace)
    const result = await tool.execute({} as any)
    expect(result).toContain('Unknown path')
  })

  test('strips think tags from content', async () => {
    const fp = join(workspace, 'think.txt')
    writeFileSync(fp, "Before<think>thinking</think>After", "utf-8")

    const tool = new ReadFileTool(workspace)
    const result = await tool.execute({ path: 'think.txt' } as any)
    expect(result).toContain('Before')
    expect(result).toContain('After')
    expect(result).not.toContain('</think>')
  })

  test('respects allowed_dir restriction', async () => {
    const allowed = join(workspace, 'allowed')
    mkdirSync(allowed)
    writeFileSync(join(allowed, 'ok.txt'), 'safe', 'utf-8')

    // Test allowed_dir: set workspace=allowed so relative paths resolve within it
    const tool = new ReadFileTool(undefined, allowed)
    const result = await tool.execute({ path: 'ok.txt' } as any)
    expect(result).toContain('safe')

    // Try to read outside allowed dir via ../
    const result2 = await tool.execute({ path: '../secret.txt' } as any)
    expect(result2).toContain('outside allowed directory')
  })
})

// ============ WriteFileTool ============

describe('WriteFileTool', () => {
  test('writes a new file', async () => {
    const tool = new WriteFileTool(workspace)
    const result = await tool.execute({ path: 'new.txt', content: 'Hello!' } as any)
    expect(result).toContain('Successfully wrote')
    expect(result).toContain('6 characters')
    expect(existsSync(join(workspace, 'new.txt'))).toBe(true)
  })

  test('creates parent directories', async () => {
    const tool = new WriteFileTool(workspace)
    const result = await tool.execute({ path: 'a/b/c/deep.txt', content: 'deep' } as any)
    expect(result).toContain('Successfully wrote')
    expect(existsSync(join(workspace, 'a', 'b', 'c', 'deep.txt'))).toBe(true)
  })

  test('overwrites existing file', async () => {
    writeFileSync(join(workspace, 'exist.txt'), 'old content', 'utf-8')
    const tool = new WriteFileTool(workspace)
    await tool.execute({ path: 'exist.txt', content: 'new content' } as any)
    const content = require('node:fs').readFileSync(join(workspace, 'exist.txt'), 'utf-8')
    expect(content).toBe('new content')
  })

  test('returns error for missing path', async () => {
    const tool = new WriteFileTool(workspace)
    const result = await tool.execute({ content: 'test' } as any)
    expect(result).toContain('Error')
  })

  test('returns error for missing content', async () => {
    const tool = new WriteFileTool(workspace)
    const result = await tool.execute({ path: 'test.txt' } as any)
    expect(result).toContain('Error')
  })
})

// ============ EditFileTool ============

describe('EditFileTool', () => {
  test('edits a file by replacing text', async () => {
    const fp = join(workspace, 'edit.txt')
    writeFileSync(fp, 'Hello World!\nGoodbye World!', 'utf-8')

    const tool = new EditFileTool(workspace)
    const result = await tool.execute({ path: 'edit.txt', old_text: 'Goodbye', new_text: 'See you' } as any)
    expect(result).toContain('Successfully edited')

    const content = require('node:fs').readFileSync(fp, 'utf-8')
    expect(content).toContain('See you World!')
    expect(content).toContain('Hello World!')
  })

  test('creates file with empty old_text', async () => {
    const tool = new EditFileTool(workspace)
    const result = await tool.execute({ path: 'created.txt', old_text: '', new_text: 'New content' } as any)
    expect(result).toContain('Successfully created')
    expect(existsSync(join(workspace, 'created.txt'))).toBe(true)
  })

  test('returns error for non-existent file (non-create)', async () => {
    const tool = new EditFileTool(workspace)
    const result = await tool.execute({ path: 'missing.txt', old_text: 'foo', new_text: 'bar' } as any)
    expect(result).toContain('File not found')
  })

  test('returns error when old_text not found', async () => {
    const fp = join(workspace, 'nomatch.txt')
    writeFileSync(fp, 'Some content here', 'utf-8')

    const tool = new EditFileTool(workspace)
    const result = await tool.execute({ path: 'nomatch.txt', old_text: 'not found at all', new_text: 'x' } as any)
    expect(result).toContain('not found')
  })

  test('warns on multiple matches', async () => {
    const fp = join(workspace, 'multi.txt')
    writeFileSync(fp, 'foo\nbar\nfoo\nbaz', 'utf-8')

    const tool = new EditFileTool(workspace)
    const result = await tool.execute({ path: 'multi.txt', old_text: 'foo', new_text: 'qux' } as any)
    expect(result).toContain('appears 2 times')
  })

  test('replaces all when replace_all=true', async () => {
    const fp = join(workspace, 'replaceall.txt')
    writeFileSync(fp, 'foo\nbar\nfoo\nbaz', 'utf-8')

    const tool = new EditFileTool(workspace)
    const result = await tool.execute({ path: 'replaceall.txt', old_text: 'foo', new_text: 'qux', replace_all: true } as any)
    expect(result).toContain('Successfully edited')

    const content = require('node:fs').readFileSync(fp, 'utf-8')
    expect(content).toContain('qux\nbar\nqux\nbaz')
  })
})

// ============ ListDirTool ============

describe('ListDirTool', () => {
  test('lists directory contents', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'a', 'utf-8')
    writeFileSync(join(workspace, 'b.txt'), 'b', 'utf-8')
    mkdirSync(join(workspace, 'sub'))

    const tool = new ListDirTool(workspace)
    const result = await tool.execute({ path: '.' } as any)
    expect(result).toContain('a.txt')
    expect(result).toContain('b.txt')
    expect(result).toContain('[D] sub')
  })

  test('recursively lists contents', async () => {
    writeFileSync(join(workspace, 'root.txt'), 'root', 'utf-8')
    mkdirSync(join(workspace, 'sub'))
    writeFileSync(join(workspace, 'sub', 'nested.txt'), 'nested', 'utf-8')

    const tool = new ListDirTool(workspace)
    const result = await tool.execute({ path: '.', recursive: true } as any)
    expect(result).toContain('root.txt')
    expect(result).toContain('sub/nested.txt')
  })

  test('ignores noise directories', async () => {
    mkdirSync(join(workspace, '.git'))
    mkdirSync(join(workspace, 'node_modules'))
    writeFileSync(join(workspace, 'src.ts'), 'x', 'utf-8')

    const tool = new ListDirTool(workspace)
    const result = await tool.execute({ path: '.' } as any)
    expect(result).toContain('src.ts')
    expect(result).not.toContain('.git')
    expect(result).not.toContain('node_modules')
  })

  test('returns error for non-existent directory', async () => {
    const tool = new ListDirTool(workspace)
    const result = await tool.execute({ path: 'nonexistent' } as any)
    expect(result).toContain('not found')
  })

  test('respects max_entries', async () => {
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(workspace, `file${i}.txt`), 'x', 'utf-8')
    }

    const tool = new ListDirTool(workspace)
    const result = await tool.execute({ path: '.', max_entries: 5 } as any)
    expect(result).toContain('truncated')
    expect(result).toContain('showing first 5')
  })
})

// ============ allowed_dir ============

describe('FsTool allowed_dir', () => {
  test('WriteFileTool respects allowed_dir', async () => {
    const allowed = join(workspace, 'sandbox')
    mkdirSync(allowed)

    // Test allowed_dir: set workspace=allowed so relative paths resolve within it
    const tool = new WriteFileTool(undefined, allowed)
    // Should work inside allowed dir
    const result = await tool.execute({ path: 'ok.txt', content: 'safe' } as any)
    expect(result).toContain('Successfully wrote')

    // Should fail outside
    const result2 = await tool.execute({ path: '../outside.txt', content: 'x' } as any)
    expect(result2).toContain('outside allowed directory')
  })
})
