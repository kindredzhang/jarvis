#!/usr/bin/env bun
/**
 * jarvis —— Personal AI Assistant CLI
 *
 * nanobot 1:1 复刻:
 *   jarvis agent    交互式 REPL / 单次消息
 *   jarvis gateway  启动网关（AgentLoop + Cron + Heartbeat + Health）
 *   jarvis serve    启动 OpenAI 兼容 API 服务器
 *   jarvis onboard  初始化配置和工作区
 *   jarvis status   显示运行状态
 */

import { Command } from 'commander'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline'
import chalk from 'chalk'
import ora from 'ora'
import { DeepSeekProvider } from './providers/deepseek'
import { AgentLoop } from './agent/loop'
import { loadConfig } from './config'
import { createAPIServer } from './api/server'
import { CronService } from './cron/service'
import { HeartbeatService } from './heartbeat/service'

const LOGO = `
 ██╗ █████╗ ██████╗ ██╗   ██╗██╗███████╗
 ██║██╔══██╗██╔══██╗██║   ██║██║██╔════╝
 ██║███████║██████╔╝██║   ██║██║███████╗
 ██║██╔══██║██╔══██╗╚██╗ ██╔╝██║╚════██║
 ██║██║  ██║██║  ██║ ╚████╔╝ ██║███████║
 ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝  ╚═╝╚══════╝

  Personal AI Assistant
`

function makeProvider(config: any) {
  return new DeepSeekProvider({ apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl })
}

function getWorkspace(config: any) {
  const ws = config.workspace ?? join(homedir(), '.jarvis')
  if (!existsSync(ws)) mkdirSync(ws, { recursive: true })
  return ws
}

// ---- Markdown 渲染 ----
function renderMarkdown(text: string): string {
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => chalk.dim('```'+(lang||'')) + '\n' + code.trim() + '\n' + chalk.dim('```'))
  text = text.replace(/`([^`]+)`/g, (_, c) => chalk.cyan(c))
  text = text.replace(/\*\*(.+?)\*\*/g, (_, t) => chalk.bold(t))
  text = text.replace(/^#{1,6}\s+(.+)$/gm, (_, t) => chalk.bold.underline(t))
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => chalk.blue(t) + chalk.dim(` (${u})`))
  return text
}

// ──── agent 命令 ────
async function cmdAgent(opts: any) {
  const config = loadConfig(opts.config)
  if (!config.apiKey) { console.error(chalk.red('✗ Error: DEEPSEEK_API_KEY required')); return }
  const provider = makeProvider(config)
  const loop = new AgentLoop({ provider, workspace: getWorkspace(config), model: config.model, timezone: config.timezone })

  const msg: string | undefined = opts.message
  if (msg) {
    const spinner = ora({ text: 'thinking...', color: 'cyan' }).start()
    const r = await loop.processDirect(msg!)
    spinner.stop()
    if (r?.content) console.log(renderMarkdown(r.content))
    return
  }

  // Interactive REPL
  const history = (() => { try { return readFileSync(join(homedir(), '.jarvis', 'history.txt'), 'utf-8').split('\n').filter(Boolean).slice(-100) } catch { return [] } })()
  const SLASH = ['/help','/new','/stop','/status','/dream','/dream-log','/dream-restore','/restart']
  const rl = createInterface({ input: stdin, output: stdout, prompt: chalk.cyan('jarvis> '), completer: (line: string) => [line.startsWith('/') ? SLASH.filter(c => c.startsWith(line.toLowerCase())) : SLASH, line], history, historySize: 100 })
  const isExit = (s: string) => ['exit','quit','/exit','/quit',':q','q'].includes(s.toLowerCase().trim())

  process.on('SIGINT', () => { console.log(chalk.dim('\nGoodbye!')); process.exit(0) })
  console.log(chalk.bold(`\n${LOGO}`) + chalk.dim('\nType /help for commands. Tab to complete.\n'))
  rl.prompt()

  rl.on('line', async (raw: string) => {
    const input = raw.trim()
    if (!input) { rl.prompt(); return }
    if (isExit(input)) { console.log(chalk.dim('Goodbye!')); rl.close(); return }
    try { appendFileSync(join(homedir(), '.jarvis', 'history.txt'), input + '\n', 'utf-8') } catch {}
    rl.pause()
    const spinner = ora({ text: 'thinking...', color: 'cyan' }).start()
    try {
      const r = await loop.processDirect(input)
      spinner.stop()
      if (r?.content) console.log('\n' + renderMarkdown(r.content))
    } catch (e) { spinner.fail(String(e)) }
    console.log()
    rl.prompt()
  })
}

// ──── gateway 命令 ────
async function cmdGateway(opts: any) {
  const config = loadConfig(opts.config)
  if (!config.apiKey) { console.error(chalk.red('✗ Error: DEEPSEEK_API_KEY required')); return }

  const workspace = getWorkspace(config)
  const provider = makeProvider(config)
  const port = parseInt(opts.port) || 18790

  console.log(chalk.bold(`\n${LOGO}`))
  console.log(chalk.dim(`  Starting gateway on port ${port}...\n`))

  // Agent
  const loop = new AgentLoop({ provider, workspace, model: config.model, timezone: config.timezone })

  // Cron
  const cronPath = join(workspace, 'cron', 'jobs.json')
  const cron = new CronService(cronPath)

  // Heartbeat
  const hb = new HeartbeatService({ workspace, provider, model: config.model ?? 'deepseek-chat' })

  // Health server
  const server = Bun.serve({
    port,
    fetch() { return new Response(JSON.stringify({ status: 'ok' }), { headers: { 'Content-Type': 'application/json' } }) },
  })

    console.log(chalk.dim(`  Health: http://localhost:${port}/health\n`))

  // Start services
  cron.start()
  hb.start()
  console.log(cron.listJobs().length > 0 ? chalk.green('✓') + ' Cron: ' + cron.listJobs().length + ' scheduled jobs' : '')
  console.log(chalk.green('✓') + ' Heartbeat: every 1800s')

  // Keep alive
  process.on('SIGINT', () => { server.stop(); cron.stop(); hb.stop(); console.log(chalk.dim('\nShutting down...')); process.exit(0) })
  await new Promise(() => {}) // block forever
}

// ──── serve 命令 ────
async function cmdServe(opts: any) {
  const config = loadConfig(opts.config)
  if (!config.apiKey) { console.error(chalk.red('✗ Error: DEEPSEEK_API_KEY required')); return }
  const provider = makeProvider(config)
  const loop = new AgentLoop({ provider, workspace: getWorkspace(config), model: config.model })
  createAPIServer({ agentLoop: loop, port: opts.port ?? 3000 })
  console.log(chalk.green('✓') + ' API server running on http://localhost:' + (parseInt(opts.port) || 8000))
}

// ──── onboard 命令 ────
function cmdOnboard(opts: any) {
  const ws = opts.workspace ? opts.workspace : join(homedir(), '.jarvis')
  if (!existsSync(ws)) mkdirSync(ws, { recursive: true })

  const cfgPath = join(homedir(), '.jarvis', 'config.json')
  if (!existsSync(cfgPath)) {
    mkdirSync(join(homedir(), '.jarvis'), { recursive: true })
    writeFileSync(cfgPath, JSON.stringify({ apiKey: '', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', workspace: ws }, null, 2), 'utf-8')
    console.log(chalk.green('✓') + ` Created config at ${cfgPath}`)
  } else {
    console.log(chalk.yellow('Config already exists at ') + cfgPath)
  }

  if (!existsSync(ws)) mkdirSync(ws, { recursive: true })
  console.log(chalk.green('✓') + ` Workspace ready at ${ws}`)
  console.log(chalk.dim(`\n  1. Add API key: export DEEPSEEK_API_KEY=sk-xxx\n  2. Chat: jarvis agent\n  3. Gateway: jarvis gateway\n`))
}

// ──── status 命令 ────
async function cmdStatus(opts: any) {
  const config = loadConfig(opts.config)
  console.log(chalk.bold('\n  jarvis status\n'))
  console.log('  ' + chalk.cyan('Model') + '   ' + (config.model ?? 'deepseek-chat'))
  console.log('  ' + chalk.dim('URL') + '     ' + (config.baseUrl ?? 'https://api.deepseek.com/v1'))
  console.log('  ' + chalk.dim('WS') + '      ' + getWorkspace(config))
  console.log(`  API Key:  ${config.apiKey ? chalk.green('✓ configured') : chalk.red('✗ missing')}\n`)
}

// ──── CLI 注册 ────
const program = new Command()
program.name('jarvis').description('Personal AI Assistant').version('1.0.0')

program.command('agent')
  .description('Interact with the agent directly')
  .option('-m, --message <msg>', 'Single message mode')
  .option('-c, --config <path>', 'Config file')
  .action(cmdAgent)

program.command('gateway')
  .description('Start the gateway (agent + cron + heartbeat)')
  .option('-p, --port <n>', 'Port (default 18790)', '18790')
  .option('-c, --config <path>', 'Config file')
  .action(cmdGateway)

program.command('serve')
  .description('Start OpenAI-compatible API server')
  .option('-p, --port <n>', 'Port (default 8000)', '8000')
  .option('-c, --config <path>', 'Config file')
  .action(cmdServe)

program.command('onboard')
  .description('Initialize config and workspace')
  .option('-w, --workspace <path>', 'Workspace path')
  .option('-c, --config <path>', 'Config file')
  .action(cmdOnboard)

program.command('status')
  .description('Show system status')
  .option('-c, --config <path>', 'Config file')
  .action(cmdStatus)

// Default: agent
if (process.argv.length <= 2) process.argv.push('agent')
program.parse()
