#!/usr/bin/env bun
/**
 * jarvis —— CLI 入口
 *
 * 交互式 REPL：直接运行 `bun run cli`
 * 单次消息：`bun run cli -- -m "你的问题"`
 */

import { createInterface } from 'node:readline/promises'
import { stdin, stdout, exit, on } from 'node:process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DeepSeekProvider } from './providers/deepseek'
import { AgentLoop, type StreamCallbacks } from './agent/loop'
import { loadConfig } from './config'

// ---- 命令行参数解析 ----

const args = process.argv.slice(2)
let messageMode = false
let message = ''
let configPath: string | undefined

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '-m':
    case '--message':
      messageMode = true
      message = args[++i] ?? ''
      break
    case '-c':
    case '--config':
      configPath = args[++i]
      break
    case '-h':
    case '--help':
      console.log(`
jarvis - Personal AI Assistant

Usage:
  bun run cli                   进入交互式 REPL
  bun run cli -- -m "消息"      单次消息模式
  bun run cli -- -c config.json 指定配置文件
  bun run cli -- -h             帮助

环境变量:
  DEEPSEEK_API_KEY   DeepSeek API Key（必需）
  DEEPSEEK_BASE_URL  API 基础 URL（可选）
  JARVIS_MODEL       模型名（可选，默认 deepseek-chat）
  JARVIS_WORKSPACE   工作区路径（可选）
      `)
      exit(0)
  }
}

// ---- 初始化 ----

async function main() {
  const config = loadConfig(configPath)

  if (!config.apiKey) {
    console.error(
      'Error: DEEPSEEK_API_KEY is required.\n' +
      'Set it via environment variable or in jarvis.json.'
    )
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

  if (messageMode) {
    await runSingleMessage(loop, message)
  } else {
    await runInteractive(loop)
  }
}

// ---- 单次消息模式 ----

async function runSingleMessage(loop: AgentLoop, message: string) {
  console.log(`\n  Sending: ${message}\n`)
  const response = await loop.processDirect(message)
  if (response?.content) {
    console.log(response.content)
  }
  exit(0)
}

// ---- 交互式 REPL ----

async function runInteractive(loop: AgentLoop) {
  const rl = createInterface({
    input: stdin,
    output: stdout,
    prompt: 'jarvis> ',
  })

  const EXIT_COMMANDS = new Set(['exit', 'quit', '/exit', '/quit', ':q', 'q'])
  const isExit = (s: string) => EXIT_COMMANDS.has(s.trim().toLowerCase())

  // Ctrl+C handler
  on('SIGINT', () => {
    console.log('\nGoodbye!')
    exit(0)
  })

  console.log(
    `\n  jarvis interactive mode — type "exit" or Ctrl+C to quit\n`
  )

  rl.prompt()

  for await (const line of rl) {
    const input = line.trim()
    if (!input) {
      rl.prompt()
      continue
    }

    if (isExit(input)) {
      console.log('Goodbye!')
      break
    }

    rl.pause()

    // Streaming callbacks
    let streamBuf = ''
    const callbacks: StreamCallbacks = {
      onStream(delta: string) {
        streamBuf += delta
        process.stdout.write(delta)
      },
      onStreamEnd(resuming: boolean) {
        if (!resuming && streamBuf) {
          process.stdout.write('\n')
        }
      },
    }

    const response = await loop.processDirect(input, { callbacks })

    if (!streamBuf) {
      // Non-streaming response
      if (response?.content) {
        console.log(response.content)
      }
    }

    console.log() // blank line
    rl.prompt()
  }

  rl.close()
}

main().catch((err) => {
  console.error('Fatal error:', err)
  exit(1)
})
