import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { GlobTool, GrepTool } from './search'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'jarvis-search-test-'))
})

afterEach(() => {
  try {
    rmSync(workspace, { recursive: true, force: true })
  } catch {
    // ignore cleanup errors
  }
})

// ============ GlobTool ============

describe('GlobTool', () => {
  test('finds files matching pattern', async () => {
    writeFileSync(join(workspace, 'foo.py'), 'x', 'utf-8')
    writeFileSync(join(workspace, 'bar.py'), 'x', 'utf-8')
    writeFileSync(join(workspace, 'readme.md'), 'x', 'utf-8')

    const tool = new GlobTool()
    const result = await tool.execute({ pattern: '*.py', path: workspace })
    expect(result).toContain('foo.py')
    expect(result).toContain('bar.py')
    expect(result).not.toContain('readme.md')
  })

  test('recursive ** glob', async () => {
    mkdirSync(join(workspace, 'src'))
    mkdirSync(join(workspace, 'src', 'utils'))
    writeFileSync(join(workspace, 'src', 'main.ts'), 'x', 'utf-8')
    writeFileSync(join(workspace, 'src', 'utils', 'helper.ts'), 'x', 'utf-8')

    const tool = new GlobTool()
    const result = await tool.execute({ pattern: '**/*.ts', path: workspace })
    expect(result).toContain('src/main.ts')
    expect(result).toContain('src/utils/helper.ts')
  })

  test('returns no matches for non-matching pattern', async () => {
    writeFileSync(join(workspace, 'foo.py'), 'x', 'utf-8')

    const tool = new GlobTool()
    const result = await tool.execute({ pattern: '*.go', path: workspace })
    expect(result).toContain('No paths matched')
  })

  test('skips noise directories', async () => {
    mkdirSync(join(workspace, 'node_modules'))
    mkdirSync(join(workspace, '.git'))
    writeFileSync(join(workspace, 'node_modules/pkg.js'), 'x', 'utf-8')
    writeFileSync(join(workspace, '.git/config'), 'x', 'utf-8')
    writeFileSync(join(workspace, 'src.ts'), 'x', 'utf-8')

    const tool = new GlobTool()
    const result = await tool.execute({ pattern: '**/*', path: workspace })
    expect(result).toContain('src.ts')
    expect(result).not.toContain('node_modules')
    expect(result).not.toContain('.git')
  })

  test('head_limit and offset', async () => {
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(workspace, `file${i}.ts`), 'x', 'utf-8')
    }

    const tool = new GlobTool()
    const result = await tool.execute({ pattern: '*.ts', path: workspace, head_limit: 5, offset: 10 })
    expect(result).toContain('pagination')
    // Should only contain 5 files starting from offset 10
    const lines = result.split('\n').filter(l => l.includes('.ts'))
    expect(lines.length).toBeLessThanOrEqual(5)
  })

  test('error for non-existent path', async () => {
    const tool = new GlobTool()
    const result = await tool.execute({ pattern: '*.ts', path: join(workspace, 'nope') })
    expect(result).toContain('not found')
  })
})

// ============ GrepTool ============

describe('GrepTool', () => {
  test('finds matching files with files_with_matches mode', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'hello world', 'utf-8')
    writeFileSync(join(workspace, 'b.txt'), 'goodbye world', 'utf-8')
    writeFileSync(join(workspace, 'c.txt'), 'nope', 'utf-8')

    const tool = new GrepTool()
    const result = await tool.execute({ pattern: 'hello', path: workspace })
    expect(result).toContain('a.txt')
    expect(result).not.toContain('b.txt')
    expect(result).not.toContain('c.txt')
  })

  test('content mode shows matching lines', async () => {
    writeFileSync(join(workspace, 'test.txt'), 'line1\nline2 with error\nline3\nline4 error\nline5', 'utf-8')

    const tool = new GrepTool()
    const result = await tool.execute({ pattern: 'error', path: workspace, output_mode: 'content' })
    expect(result).toContain('test.txt:2')
    expect(result).toContain('> 2| line2 with error')
    expect(result).toContain('test.txt:4')
  })

  test('case insensitive search', async () => {
    writeFileSync(join(workspace, 'case.txt'), 'Hello WORLD', 'utf-8')

    const tool = new GrepTool()
    const result = await tool.execute({ pattern: 'world', path: workspace, case_insensitive: true })
    expect(result).toContain('case.txt')
  })

  test('returns no matches for non-matching pattern', async () => {
    writeFileSync(join(workspace, 'test.txt'), 'hello', 'utf-8')

    const tool = new GrepTool()
    const result = await tool.execute({ pattern: 'zzzz', path: workspace })
    expect(result).toContain('No matches found')
  })

  test('glob filter narrows search', async () => {
    writeFileSync(join(workspace, 'data.ts'), 'const x = 1', 'utf-8')
    writeFileSync(join(workspace, 'data.py'), 'x = 1', 'utf-8')

    const tool = new GrepTool()
    const result = await tool.execute({ pattern: 'const', path: workspace, glob: '*.ts' })
    expect(result).toContain('data.ts')
    expect(result).not.toContain('data.py')
  })

  test('skips binary files', async () => {
    // Write a file with null bytes (binary)
    const buf = Buffer.alloc(100)
    buf.write('hello\x00world')
    writeFileSync(join(workspace, 'binary.bin'), buf)
    writeFileSync(join(workspace, 'text.txt'), 'hello binary', 'utf-8')

    const tool = new GrepTool()
    const result = await tool.execute({ pattern: 'hello', path: workspace })
    expect(result).not.toContain('binary.bin')
    expect(result).toContain('text.txt')
  })

  test('head_limit and offset', async () => {
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(workspace, `file${i}.txt`), `unique_match_${i}`, 'utf-8')
    }

    const tool = new GrepTool()
    const result = await tool.execute({ pattern: 'unique_match', path: workspace, head_limit: 3 })
    const lines = result.split('\n').filter(l => l.includes('.txt'))
    expect(lines.length).toBeLessThanOrEqual(3)
  })

  test('invalid regex returns error', async () => {
    writeFileSync(join(workspace, 'test.txt'), 'hello', 'utf-8')

    const tool = new GrepTool()
    const result = await tool.execute({ pattern: '[invalid', path: workspace })
    expect(result).toContain('invalid regex')
  })

  test('error for non-existent path', async () => {
    const tool = new GrepTool()
    const result = await tool.execute({ pattern: 'x', path: join(workspace, 'nope') })
    expect(result).toContain('not found')
  })
})
