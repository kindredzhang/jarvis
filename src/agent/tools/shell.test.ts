import { test, expect, describe } from 'bun:test'
import { ExecTool } from './shell'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

// ============ Basic execution ============

describe('ExecTool basic', () => {
  test('executes a simple command', async () => {
    const tool = new ExecTool()
    const result = await tool.execute({ command: 'echo hello', timeout: 5 })
    expect(result).toContain('hello')
    expect(result).toContain('Exit code: 0')
  })

  test('multiple commands with separator', async () => {
    const tool = new ExecTool()
    const result = await tool.execute({ command: 'echo first && echo second', timeout: 5 })
    expect(result).toContain('first')
    expect(result).toContain('second')
    expect(result).toContain('Exit code: 0')
  })

  test('captures stderr', async () => {
    const tool = new ExecTool()
    const result = await tool.execute({ command: 'echo ok && ls /nonexistent 2>&1', timeout: 5 })
    expect(result).toContain('ok')
    expect(result).toContain('No such file')
  })

  test('non-zero exit code', async () => {
    const tool = new ExecTool()
    const result = await tool.execute({ command: 'false', timeout: 5 })
    expect(result).toContain('Exit code: 1')
  })

  test('error for no command', async () => {
    const tool = new ExecTool()
    const result = await tool.execute({})
    expect(result).toContain('No command')
  })
})

// ============ Timeout ============

describe('ExecTool timeout', () => {
  test('times out long running command', async () => {
    const tool = new ExecTool()
    const result = await tool.execute({ command: 'sleep 30', timeout: 1 })
    expect(result).toContain('timed out')
  })
})

// ============ Safety guards ============

describe('ExecTool safety guards', () => {
  test('blocks rm -rf', async () => {
    const tool = new ExecTool()
    const result = await tool.execute({ command: 'rm -rf /tmp', timeout: 5 })
    expect(result).toContain('blocked')
  })

  test('blocks shutdown', async () => {
    const tool = new ExecTool()
    const result = await tool.execute({ command: 'shutdown now', timeout: 5 })
    expect(result).toContain('blocked')
  })

  test('blocks dd if= disk write', async () => {
    const tool = new ExecTool()
    const result = await tool.execute({ command: 'dd if=/dev/zero of=/tmp/test bs=1 count=1', timeout: 5 })
    expect(result).toContain('blocked')
  })

  test('blocks path traversal when restrictToWorkspace enabled', async () => {
    const tool = new ExecTool({ restrictToWorkspace: true })
    const result = await tool.execute({ command: 'cat ../secret.txt', timeout: 5 })
    expect(result).toContain('blocked')
  })

  test('allow patterns passthrough', async () => {
    const tool = new ExecTool({
      allowPatterns: [/^echo/],
    })
    const result = await tool.execute({ command: 'echo allowed', timeout: 5 })
    expect(result).toContain('allowed')
    expect(result).toContain('Exit code: 0')
  })

  test('allow patterns block non-matching', async () => {
    const tool = new ExecTool({
      allowPatterns: [/^echo/],
    })
    const result = await tool.execute({ command: 'ls', timeout: 5 })
    expect(result).toContain('blocked')
  })
})

// ============ Working directory ============

describe('ExecTool working directory', () => {
  test('executes in custom working directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'exec-test-'))
    writeFileSync(join(dir, 'testfile.txt'), 'hello from wd', 'utf-8')

    const tool = new ExecTool()
    const result = await tool.execute({ command: 'cat testfile.txt', working_dir: dir, timeout: 5 })
    expect(result).toContain('hello from wd')

    rmSync(dir, { recursive: true, force: true })
  })
})

// ============ Output truncation ============

describe('ExecTool output truncation', () => {
  test('truncates very long output', async () => {
    const tool = new ExecTool()
    // Generate output larger than MAX_OUTPUT (10K chars)
    const result = await tool.execute({ command: 'python3 -c "print(\\"x\\" * 15000)"', timeout: 5 })
    expect(result).toContain('chars truncated')
  })
})
