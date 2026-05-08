#!/usr/bin/env bun
/**
 * jarvis core CLI — thin wrapper that delegates to Python TUI.
 * Run `jarvis` from the tui/ directory for the full experience.
 */

import { Command } from 'commander'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { DeepSeekProvider } from './providers/deepseek'
import { AgentLoop } from './agent/loop'
import { loadConfig } from './config'
import { createAPIServer } from './api/server'
import { CronService } from './cron/service'
import { HeartbeatService } from './heartbeat/service'

function makeProvider(config: any) {
  return new DeepSeekProvider({ apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl })
}

function getWorkspace(config: any) {
  const ws = config.workspace ?? join(homedir(), '.jarvis')
  if (!existsSync(ws)) mkdirSync(ws, { recursive: true })
  return ws
}

const program = new Command()
program.name('jarvis').description('Personal AI Assistant (core)')
program.option('-m, --message <msg>', 'Single message mode (calls agent)')

// ──── agent ────
async function cmdAgent(opts: any) {
  const config = loadConfig(opts.config)
  if (!config.apiKey) { console.error('Error: DEEPSEEK_API_KEY required'); return }
  const provider = makeProvider(config)
  const loop = new AgentLoop({ provider, workspace: getWorkspace(config), model: config.model, timezone: config.timezone })
  if (typeof opts.message === 'string') {
    const r = await loop.processDirect(opts.message)
    if (r?.content) console.log(r.content)
    return
  }
  // Interactive: use basic readline (Python TUI replaces this)
  const { createInterface } = await import('node:readline')
  const { stdin, stdout } = await import('node:process')
  const rl = createInterface({ input: stdin, output: stdout })
  console.log('jarvis> (use TUI for full experience: cd tui && uv run jarvis agent)')
  rl.on('line', async (line: string) => {
    const input = line.trim()
    if (!input) { rl.prompt(); return }
    if (['exit','quit',':q'].includes(input.toLowerCase())) { rl.close(); return }
    const r = await loop.processDirect(input)
    if (r?.content) console.log(r.content)
    rl.prompt()
  })
  rl.prompt()
}

// ──── gateway ────
async function cmdGateway(opts: any) {
  const config = loadConfig(opts.config)
  if (!config.apiKey) { console.error('Error: DEEPSEEK_API_KEY required'); return }
  const workspace = getWorkspace(config)
  const provider = makeProvider(config)
  const port = parseInt(opts.port) || 18790

  console.log(`Starting jarvis gateway on port ${port}...`)
  const loop = new AgentLoop({ provider, workspace, model: config.model, timezone: config.timezone })
  const cron = new CronService(join(workspace, 'cron', 'jobs.json'))
  const hb = new HeartbeatService({ workspace, provider, model: config.model ?? 'deepseek-chat' })

  const server = Bun.serve({ port, fetch() { return new Response(JSON.stringify({ status: 'ok' }), { headers: { 'Content-Type': 'application/json' } }) } })
  cron.start()
  hb.start()
  console.log('Cron: started')
  console.log('Heartbeat: started')
  console.log(`Health: http://localhost:${port}/health`)

  process.on('SIGINT', () => { server.stop(); cron.stop(); hb.stop(); process.exit(0) })
  await new Promise(() => {})
}

// ──── serve ────
async function cmdServe(opts: any) {
  const config = loadConfig(opts.config)
  if (!config.apiKey) { console.error('Error: DEEPSEEK_API_KEY required'); return }
  const provider = makeProvider(config)
  const loop = new AgentLoop({ provider, workspace: getWorkspace(config), model: config.model })
  const port = parseInt(opts.port) || 8000
  createAPIServer({ agentLoop: loop, port })
  console.log(`API server running on http://localhost:${port}`)
}

// ──── onboard ────
function cmdOnboard(opts: any) {
  const ws = opts.workspace ? opts.workspace : join(homedir(), '.jarvis')
  if (!existsSync(ws)) mkdirSync(ws, { recursive: true })
  const cfgPath = join(homedir(), '.jarvis', 'config.json')
  if (!existsSync(cfgPath)) {
    mkdirSync(join(homedir(), '.jarvis'), { recursive: true })
    writeFileSync(cfgPath, JSON.stringify({ apiKey: '', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', workspace: ws }, null, 2), 'utf-8')
    console.log(`Created config at ${cfgPath}`)
  } else { console.log(`Config exists at ${cfgPath}`) }
  console.log(`Workspace ready at ${ws}`)
}

// ──── status ────
async function cmdStatus(opts: any) {
  const config = loadConfig(opts.config)
  console.log('jarvis status')
  console.log(`  Model:    ${config.model ?? 'deepseek-chat'}`)
  console.log(`  URL:      ${config.baseUrl ?? 'https://api.deepseek.com/v1'}`)
  console.log(`  WS:       ${getWorkspace(config)}`)
  console.log(`  API Key:  ${config.apiKey ? 'configured' : 'missing'}`)
}

program.command('agent').description('Direct agent mode (use Python TUI for full experience)').option('-m, --message <msg>').option('-c, --config <path>').action(cmdAgent)
program.command('gateway').description('Start the gateway').option('-p, --port <n>', '18790').option('-c, --config <path>').action(cmdGateway)
program.command('serve').description('Start API server').option('-p, --port <n>', '8000').option('-c, --config <path>').action(cmdServe)
program.command('onboard').description('Initialize config').option('-w, --workspace <path>').action(cmdOnboard)
program.command('status').description('Show status').option('-c, --config <path>').action(cmdStatus)

if (process.argv.length <= 2 && process.env._JARVIS_TUI) process.argv.push('agent')
program.parse()
