#!/usr/bin/env bun
/**
 * jarvis —— CLI 入口（交互式 REPL + 单次消息）
 *
 * 用法：
 *   jarvis                      交互式 REPL
 *   jarvis -m "消息"            单次消息
 *   jarvis -c config.json       指定配置
 *
 * 流式输出 / spinner / 输入历史 / 信号处理 / Markdown 渲染
 */

import { createInterface } from 'node:readline/promises'
import { stdin, stdout, exit, argv, cwd } from 'node:process'
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import chalk from 'chalk'
import ora from 'ora'
import { DeepSeekProvider } from './providers/deepseek'
import { OpenAICompatProvider } from './providers/openai-compat'
import { AnthropicProvider } from './providers/anthropic'
import { AgentLoop } from './agent/loop'
import { loadConfig } from './config'

// ---- Markdown 简易渲染 ----

function renderMarkdown(text: string): string {
  // 代码块 (```)
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    return chalk.dim('```' + (lang || '')) + '\n' + code.trim() + '\n' + chalk.dim('```')
  })
  // 行内代码 (`code`)
  text = text.replace(/`([^`]+)`/g, (_, code) => chalk.cyan(code))
  // 加粗 (**text**)
  text = text.replace(/\*\*(.+?)\*\*/g, (_, t) => chalk.bold(t))
  // 斜体 (*text*)
  text = text.replace(/\*(.+?)\*/g, (_, t) => chalk.italic(t))
  // 标题 (# heading)
  text = text.replace(/^(#{1,6})\s+(.+)$/gm, (_, hashes, t) => chalk.bold.underline(t))
  // 列表 (- item)
  text = text.replace(/^(\s*[-*+])\s+(.+)$/gm, (_, bullet, t) => `${chalk.dim(bullet)} ${t}`)
  // 数字列表 (1. item)
  text = text.replace(/^(\s*\d+\.)\s+(.+)$/gm, (_, num, t) => `${chalk.dim(num)} ${t}`)
  // 引用 (> text)
  text = text.replace(/^>\s+(.+)$/gm, (_, t) => chalk.dim(`│ ${t}`))
  // 链接 [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, url) => chalk.blue(t) + chalk.dim(` (${url})`))
  return text
}

// ---- CLI ----

async function main() {
  const config = loadConfig()

  if (!config.apiKey) {
    console.error(chalk.red('✖ Error: DEEPSEEK_API_KEY is required.'))
    console.error(chalk.dim('  Set it via environment variable or in jarvis.json'))
    exit(1)
  }

  // 确保工作区存在
  if (!existsSync(config.workspace!)) {
    mkdirSync(config.workspace!, { recursive: true })
  }

  // 初始化 provider
  const provider = new DeepSeekProvider({
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
  })

  // 初始化 AgentLoop
  const loop = new AgentLoop({
    provider,
    workspace: config.workspace!,
    model: config.model,
    maxIterations: config.maxIterations,
    maxToolResultChars: config.maxToolResultChars,
    timezone: config.timezone,
  })

  const args = process.argv.slice(2)
  let messageMode = false
  let message = ''

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-m':
      case '--message':
        messageMode = true
        message = args[++i] ?? ''
        break
      case '-h':
      case '--help':
        printHelp()
        exit(0)
    }
  }

  if (messageMode) {
    await runSingle(loop, message)
  } else {
    await runRepl(loop)
  }
}

function printHelp() {
  console.log(`
${chalk.bold('jarvis')} — ${chalk.dim('Personal AI Assistant')}

${chalk.bold('用法：')}
  ${chalk.cyan('jarvis')}              ${chalk.dim('交互式 REPL')}
  ${chalk.cyan('jarvis -m "消息"')}    ${chalk.dim('单次消息')}
  ${chalk.cyan('jarvis -h')}           ${chalk.dim('帮助')}

${chalk.bold('环境变量：')}
  DEEPSEEK_API_KEY   ${chalk.dim('API Key（必需）')}
  DEEPSEEK_BASE_URL  ${chalk.dim('API 地址')}
  JARVIS_MODEL       ${chalk.dim('模型名')}
  JARVIS_WORKSPACE   ${chalk.dim('工作区路径')}
`)
}

// ---- 单次消息 ----

async function runSingle(loop: AgentLoop, message: string) {
  console.log(`\n  ${chalk.dim('Sending:')} ${message}\n`)

  const spinner = ora({ text: 'thinking...', color: 'cyan' }).start()
  try {
    const response = await loop.processDirect(message)
    spinner.stop()
    if (response?.content) {
      console.log(renderMarkdown(response.content))
    }
  } catch (err) {
    spinner.fail(String(err))
  }
  exit(0)
}

// ---- 交互式 REPL ----

const HISTORY_FILE = join(homedir(), '.jarvis', 'history.txt')

function loadHistory(): string[] {
  try {
    const raw = readFileSync(HISTORY_FILE, 'utf-8')
    return raw.split('\n').filter(Boolean).slice(-100)
  } catch { return [] }
}

function saveHistory(input: string) {
  try {
    const dir = join(homedir(), '.jarvis')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(HISTORY_FILE, input + '\n', 'utf-8')
  } catch { /* ignore history errors */ }
}

async function runRepl(loop: AgentLoop) {
  const history = loadHistory()
  const rl = createInterface({
    input: stdin,
    output: stdout,
    prompt: chalk.cyan('jarvis> '),
    history,
    historySize: 100,
  })

  const EXIT_COMMANDS = new Set(['exit', 'quit', '/exit', '/quit', ':q'])
  const isExit = (s: string) => EXIT_COMMANDS.has(s.trim().toLowerCase())

  // Ctrl+C
  process.on('SIGINT', () => {
    console.log(chalk.dim('\nGoodbye!'))
    exit(0)
  })

  console.log(chalk.bold(`\n  jarvis ${chalk.dim('— Personal AI Assistant')}`))
  console.log(chalk.dim('  exit or Ctrl+C to quit\n'))

  rl.prompt()

  for await (const line of rl) {
    const input = line.trim()
    if (!input) { rl.prompt(); continue }

    if (isExit(input)) {
      console.log(chalk.dim('Goodbye!'))
      break
    }
    saveHistory(input)
    rl.pause()

    const spinner = ora({ text: 'thinking...', color: 'cyan' }).start()

    try {
      const response = await loop.processDirect(input)
      spinner.stop()
      if (response?.content) {
        console.log('\n' + renderMarkdown(response.content))
      }
    } catch (err) {
      spinner.fail(String(err))
    }

    console.log()
    rl.prompt()
  }

  rl.close()
}

main().catch((err) => {
  console.error(chalk.red(`\n✖ ${err}`))
  exit(1)
})
