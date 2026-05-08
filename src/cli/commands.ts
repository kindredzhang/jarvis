/**
 * CLI commands for jarvis.
 *
 * Port of original Python CLI commands. Every command is implemented as an
 * exported async function called from the Commander-based entry point.
 *
 * Commands:
 *   agent     Interact with the agent (single message or interactive)
 *   serve     Start OpenAI-compatible API server
 *   gateway   Start the gateway (cron + heartbeat + channels)
 *   onboard   Initialize config and workspace
 *   status    Show configuration status
 *   channels  Manage channels (status, login)
 *   plugins   List channel plugins
 *   provider  Manage providers (login with OAuth)
 */

import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import chalk from 'chalk'
import { marked } from 'marked'
import { AgentLoop } from '../agent/loop'
import { loadConfig, saveConfig, getConfigPath, setConfigPath } from '../config/loader'
import type { JarvisConfig } from '../config/schema'
import { DEFAULTS } from '../config/schema'
import { makeProviderFromConfig } from '../nanobot'
import { StreamRenderer } from './stream'
import { FileHistory } from './history'
import { PROVIDERS } from '../providers/registry'
import type { ProviderSpec } from '../providers/registry'
import { MessageBus } from '../bus/message-bus'
import { syncWorkspaceTemplates } from '../utils/template-sync'
import { consumeRestartNoticeFromEnv, shouldShowCliRestartNotice, formatRestartCompletedMessage } from '../utils/restart'
import { saveTerminalAttrs, restoreTerminalAttrs, flushPendingTtyInput } from '../utils/terminal'

// ===========================================================================
// Config loading helpers
// ===========================================================================

function getWorkspace(config: JarvisConfig): string {
  const ws = (config.agents?.defaults?.workspace ?? join(homedir(), '.jarvis')).replace(/^~/, homedir())
  if (!existsSync(ws)) mkdirSync(ws, { recursive: true })
  return ws
}

function getModel(config: JarvisConfig): string {
  return config.agents?.defaults?.model || 'deepseek-chat'
}

function getTimezone(config: JarvisConfig): string {
  return config.agents?.defaults?.timezone || 'UTC'
}

/** Load config with validation and user-friendly error messages. */
function loadRuntimeConfig(configPath?: string, workspaceOverride?: string): JarvisConfig {
  if (configPath) {
    const resolved = resolve(configPath)
    if (!existsSync(resolved)) {
      console.error(chalk.red(`Error: Config file not found: ${resolved}`))
      process.exit(1)
    }
    setConfigPath(resolved)
    console.error(chalk.dim(`Using config: ${resolved}`))
  }

  try {
    const config = loadConfig(configPath)
    if (workspaceOverride) {
      if (!config.agents) config.agents = {}
      if (!config.agents.defaults) config.agents.defaults = {}
      config.agents.defaults.workspace = workspaceOverride
    }
    return config
  } catch (e) {
    console.error(chalk.red(`Error: ${(e as Error).message}`))
    process.exit(1)
  }
}

// ===========================================================================
// Terminal helpers
// ===========================================================================

const EXIT_COMMANDS = new Set(['exit', 'quit', '/exit', '/quit', ':q'])

function isExitCommand(command: string): boolean {
  return EXIT_COMMANDS.has(command.toLowerCase())
}

// ===========================================================================
// Signal handling
// ===========================================================================

function setupSignalHandlers(): void {
  const handleSignal = (sig: string) => {
    restoreTerminalAttrs()
    console.log(`\nReceived ${sig}, goodbye!`)
    process.exit(0)
  }
  process.on('SIGINT', () => handleSignal('SIGINT'))
  process.on('SIGTERM', () => handleSignal('SIGTERM'))
  if (process.listenerCount('SIGHUP') === 0) {
    process.on('SIGHUP', () => handleSignal('SIGHUP'))
  }
  process.on('exit', () => restoreTerminalAttrs())
  // Ignore SIGPIPE to prevent silent process termination
  process.on('SIGPIPE', () => {})
}

// ===========================================================================
// Agent command — single message or interactive
// ===========================================================================

export async function cmdAgent(opts: {
  message?: string
  session?: string
  config?: string
  workspace?: string
  markdown?: boolean
}): Promise<void> {
  const config = loadRuntimeConfig(opts.config, opts.workspace)
  const ws = getWorkspace(config)
  const provider = makeProviderFromConfig(config)
  const model = getModel(config)
  const sessionId = opts.session ?? 'cli:direct'

  const loop = new AgentLoop({
    provider,
    workspace: ws,
    model,
    maxIterations: config.agents?.defaults?.maxToolIterations,
    timezone: getTimezone(config),
  })


  if (opts.message) {
    // Single message mode
    const renderer = new StreamRenderer({ renderMarkdown: opts.markdown ?? true })

    const response = await loop.processDirect(opts.message, {
      sessionKey: sessionId,
      callbacks: {
        onStream: async (delta: string) => renderer.onDelta(delta),
        onStreamEnd: async (resuming: boolean) => renderer.onEnd({ resuming }),
        onProgress: async (content: string, extra?: { toolHint?: boolean }) => {
          renderer.onProgress(content, { toolHint: extra?.toolHint })
        },
      },
    })

    if (!renderer.streamed) {
      await renderer.close()
      const content = response?.content || ''
      const metadata = response?.metadata as Record<string, unknown> | undefined
      const renderAs = metadata?.render_as as string | undefined
      if (content) {
        const body = (renderAs === 'text' || !opts.markdown) ? content : marked.parse(content, { async: false }) as string
        console.log()
        console.log(chalk.cyan('jarvis:'), body)
        console.log()
      }
    }

    return
  }

  // Interactive mode
  console.log(`${chalk.cyan('jarvis')} Interactive mode ${chalk.blue(`(${model})`)} — type ${chalk.bold('exit')} or Ctrl+C to quit`)
  console.log(`  ${chalk.dim('Commands: /help /new /stop /status /dream /dream-log /dream-restore /skills /restart')}`)
  console.log()

  const [cliChannel, cliChatId] = sessionId.includes(':')
    ? sessionId.split(':', 2) as [string, string]
    : ['cli', sessionId]

  saveTerminalAttrs()
  setupSignalHandlers()

  // Show restart notice if applicable
  const restartNotice = consumeRestartNoticeFromEnv()
  if (restartNotice && shouldShowCliRestartNotice(restartNotice, sessionId)) {
    const msg = formatRestartCompletedMessage(restartNotice.startedAtRaw)
    console.log()
    console.log(chalk.cyan('jarvis'))
    console.log(msg)
    console.log()
  }

  // Persistent file history
  const historyPath = join(homedir(), '.jarvis', 'cli_history.txt')
  mkdirSync(dirname(historyPath), { recursive: true })
  const history = new FileHistory(historyPath)

  // Interactive readline with slash-command autocomplete
  const cliCommands = loop.commands.getAllCommands().map((c) => c.toLowerCase())
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    history: history.reversed,
    historySize: 1000,
    prompt: chalk.blue('You: '),
    terminal: process.stdin.isTTY,
    completer: (line: string) => {
      const trimmed = line.trimStart()
      if (!trimmed.startsWith('/')) return [[], line]
      const hits = cliCommands.filter((c) => c.startsWith(trimmed.toLowerCase()))
      return [hits, trimmed]
    },
  })

  rl.on('close', () => {
    restoreTerminalAttrs()
    console.log('\nGoodbye!')
    process.exit(0)
  })

  rl.prompt()

  for await (const line of rl) {
    const input = line.trim()
    if (!input) { flushPendingTtyInput(); rl.prompt(); continue }
    if (isExitCommand(input)) { rl.close(); break }

    history.storeString(input)

    const renderer = new StreamRenderer({ renderMarkdown: opts.markdown ?? true })

    const response = await loop.processDirect(input, {
      sessionKey: sessionId,
      channel: cliChannel,
      chatId: cliChatId,
      callbacks: {
        onStream: async (delta: string) => renderer.onDelta(delta),
        onStreamEnd: async (resuming: boolean) => renderer.onEnd({ resuming }),
        onProgress: async (content: string, extra?: { toolHint?: boolean }) => {
          renderer.onProgress(content, { toolHint: extra?.toolHint })
        },
      },
    })

    if (!renderer.streamed) {
      await renderer.close()
      const content = response?.content || ''
      const metadata = response?.metadata as Record<string, unknown> | undefined
      const renderAs = metadata?.render_as as string | undefined
      if (content) {
        const body = (renderAs === 'text' || !opts.markdown) ? content : marked.parse(content, { async: false }) as string
        console.log()
        console.log(chalk.cyan('jarvis:'), body)
        console.log()
      }
    }

    flushPendingTtyInput()
    rl.prompt()
  }
}

// ===========================================================================
// Serve command — OpenAI-compatible API server
// ===========================================================================

export async function cmdServe(opts: {
  port?: string
  host?: string
  timeout?: string
  verbose?: boolean
  config?: string
  workspace?: string
}): Promise<void> {
  const config = loadRuntimeConfig(opts.config, opts.workspace)
  const ws = getWorkspace(config)
  const provider = makeProviderFromConfig(config)
  const model = getModel(config)

  const loop = new AgentLoop({
    provider,
    workspace: ws,
    model,
    maxIterations: config.agents?.defaults?.maxToolIterations,
    timezone: getTimezone(config),
  })

  const port = opts.port ? parseInt(opts.port) : (config.api?.port ?? 8000)
  const host = opts.host ?? config.api?.host ?? '127.0.0.1'
  const timeout = opts.timeout ? parseInt(opts.timeout) : (config.api?.timeout ?? 120)

  // Sync workspace templates
  syncWorkspaceTemplates(ws, true)

  console.log(`${chalk.cyan('jarvis')} Starting API server`)
  console.log(`  ${chalk.cyan('Endpoint')} : http://${host}:${port}/v1/chat/completions`)
  console.log(`  ${chalk.cyan('Model')}    : ${model}`)
  console.log(`  ${chalk.cyan('Session')}  : api:default`)
  console.log(`  ${chalk.cyan('Timeout')}  : ${timeout}s`)

  if (host === '0.0.0.0' || host === '::') {
    console.log(chalk.yellow('  Warning: API is bound to all interfaces. Only do this behind a trusted network boundary, firewall, or reverse proxy.'))
  }
  console.log()

  const { createAPIServer } = await import('../api/server')
  const server = createAPIServer({ agentLoop: loop, modelName: model, port, requestTimeout: timeout })

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...')
    server.stop()
    process.exit(0)
  })

  await new Promise(() => {})
}

// ===========================================================================
// Gateway command
// ===========================================================================

export async function cmdGateway(opts: {
  port?: string
  config?: string
  workspace?: string
  verbose?: boolean
}): Promise<void> {
  const config = loadRuntimeConfig(opts.config, opts.workspace)
  const ws = getWorkspace(config)
  const provider = makeProviderFromConfig(config)
  const model = getModel(config)
  const port = opts.port ? parseInt(opts.port) : (config.gateway?.port ?? 18790)
  const host = config.gateway?.host ?? '127.0.0.1'

  console.log(`${chalk.cyan('jarvis')} Starting gateway on port ${port}...`)

  const bus = new MessageBus()
  new AgentLoop({
    provider,
    workspace: ws,
    model,
    maxIterations: config.agents?.defaults?.maxToolIterations,
    timezone: getTimezone(config),
  })

  // Cron service
  const { CronService } = await import('../cron/service')
  const cronStorePath = join(ws, 'cron', 'jobs.json')
  mkdirSync(dirname(cronStorePath), { recursive: true })
  const cron = new CronService(cronStorePath)

  // Heartbeat service
  const { HeartbeatService } = await import('../heartbeat/service')
  const hb = new HeartbeatService({
    workspace: ws,
    provider,
    model,
  })

  // Channel manager
  const { ChannelManager } = await import('../channels/manager')
  const channelConfig = {
    channels: (config.channels as Record<string, Record<string, unknown>>) || {},
    sendProgress: config.channels?.sendProgress,
    sendToolHints: config.channels?.sendToolHints,
    sendMaxRetries: config.channels?.sendMaxRetries,
  }
  const channels = new ChannelManager(bus, channelConfig)
  await channels.initChannels()

  console.log(`  ${chalk.green('✓')} Channels: ${channels.channels.size} enabled`)
  console.log(`  ${chalk.green('✓')} Health: http://${host}:${port}/health`)

  cron.start()
  hb.start()
  console.log(`  ${chalk.green('✓')} Cron: started`)
  console.log(`  ${chalk.green('✓')} Heartbeat: started`)

  // Health endpoint on the gateway port
  const server = Bun.serve({
    port,
    fetch(req: Request) {
      const url = new URL(req.url)
      if (url.pathname === '/health') {
        return Response.json({ status: 'ok' })
      }
      return new Response('Not Found', { status: 404 })
    },
  })

  process.on('SIGINT', async () => {
    console.log('\nShutting down...')
    cron.stop()
    hb.stop()
    server.stop()
    await channels.stopAll()
    process.exit(0)
  })

  await new Promise(() => {})
}

// ===========================================================================
// Onboard helpers
// ===========================================================================

function mergeMissingDefaults(existing: Record<string, unknown>, defaults: Record<string, unknown>): Record<string, unknown> {
  if (!existing || !defaults) return existing ?? defaults ?? {}
  const merged: Record<string, unknown> = { ...existing }
  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in merged)) {
      merged[key] = value
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value) &&
               typeof merged[key] === 'object' && merged[key] !== null && !Array.isArray(merged[key])) {
      merged[key] = mergeMissingDefaults(merged[key] as Record<string, unknown>, value as Record<string, unknown>)
    }
  }
  return merged
}

async function onboardPlugins(configPath: string): Promise<void> {
  try {
    const { discoverAll } = await import('../channels/registry')
    const allChannels = await discoverAll()
    if (!allChannels || Object.keys(allChannels).length === 0) return

    const config: Record<string, unknown> = JSON.parse(readFileSync(configPath, 'utf-8'))
    const channels = (config.channels as Record<string, unknown>) ?? {}
    config.channels = channels

    for (const [name] of Object.entries(allChannels)) {
      const defaultCfg: Record<string, unknown> = {
        enabled: false,
        appId: '',
        appSecret: '',
        token: '',
      }
      const existing = channels[name] as Record<string, unknown> | undefined
      if (!existing) {
        channels[name] = { ...defaultCfg }
      } else {
        channels[name] = mergeMissingDefaults(existing, defaultCfg)
      }
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
  } catch {
    // Plugin injection is best-effort
  }
}

// ===========================================================================
// Onboard command
// ===========================================================================

export async function cmdOnboard(opts: {
  workspace?: string
  config?: string
  wizard?: boolean
}): Promise<void> {
  const configPath = opts.config
    ? resolve(opts.config)
    : getConfigPath()

  if (opts.config) {
    setConfigPath(configPath)
    console.error(chalk.dim(`Using config: ${configPath}`))
  }

  const applyWorkspaceOverride = (cfg: JarvisConfig): JarvisConfig => {
    if (opts.workspace) {
      if (!cfg.agents) cfg.agents = {}
      if (!cfg.agents.defaults) cfg.agents.defaults = {}
      cfg.agents.defaults.workspace = opts.workspace
    }
    return cfg
  }

  const finishOnboard = async (): Promise<void> => {
    const config = loadConfig(configPath)
    const ws = getWorkspace(config)
    if (!existsSync(ws)) {
      mkdirSync(ws, { recursive: true })
      console.log(`${chalk.green('✓')} Created workspace at ${ws}`)
    }

    await onboardPlugins(configPath)
    syncWorkspaceTemplates(ws)

    const agentCmd = `jarvis agent -m "Hello!"`
    const gatewayCmd = 'jarvis gateway'
    if (opts.config) {
      // We don't add --config here to keep it simple
    }

    console.log(`\n${chalk.cyan('jarvis')} is ready!`)
    console.log('\nNext steps:')
    console.log(`  1. Add your API key to ${chalk.cyan(configPath)}`)
    console.log('     Get one at: https://platform.deepseek.com/')
    console.log(`  2. Chat: ${chalk.cyan(agentCmd)}`)
    console.log(`  3. Start gateway: ${chalk.cyan(gatewayCmd)}`)
  }

  if (existsSync(configPath)) {
    if (opts.wizard) {
      applyWorkspaceOverride(loadConfig(configPath))
    } else {
      console.log(chalk.yellow(`Config already exists at ${configPath}`))
      console.log(`  ${chalk.bold('y')} = overwrite with defaults (existing values will be lost)`)
      console.log(`  ${chalk.bold('N')} = refresh config, keeping existing values and adding new fields`)

      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
      rl.question(chalk.blue('Overwrite? (y/N) '), async (answer: string) => {
        const yes = answer.trim().toLowerCase() === 'y'
        if (yes) {
          const config = applyWorkspaceOverride(DEFAULTS as JarvisConfig)
          saveConfig(config, configPath)
          console.log(`${chalk.green('✓')} Config reset to defaults at ${configPath}`)
        } else {
          const config = applyWorkspaceOverride(loadConfig(configPath))
          saveConfig(config, configPath)
          console.log(`${chalk.green('✓')} Config refreshed at ${configPath} (existing values preserved)`)
        }
        rl.close()
        await finishOnboard()
      })
      return
    }
  } else {
    const config = applyWorkspaceOverride(DEFAULTS as JarvisConfig)
    if (!opts.wizard) {
      saveConfig(config, configPath)
      console.log(`${chalk.green('✓')} Created config at ${configPath}`)
    }
  }

  // Run interactive wizard if enabled
  if (opts.wizard) {
    ;(async () => {
      try {
        const { runOnboard } = await import('./onboard')
        const result = await runOnboard(loadConfig(configPath))
        if (!result.shouldSave) {
          console.log(chalk.yellow('Configuration discarded. No changes were saved.'))
          return
        }
        saveConfig(result.config, configPath)
        console.log(`${chalk.green('✓')} Config saved at ${configPath}`)
      } catch (e: any) {
        if (e.message?.includes('@clack')) {
          console.error(chalk.yellow('Interactive wizard requires @clack/prompts.'))
          return
        }
        console.error(chalk.red(`Error during configuration: ${e.message}`))
        console.error(chalk.yellow("Please run 'jarvis onboard' again to complete setup."))
        return
      }
      await finishOnboard()
    })()
    return
  }

  await finishOnboard()
}

// ===========================================================================
// Status command
// ===========================================================================

export async function cmdStatus(opts: { config?: string }): Promise<void> {
  const config = loadRuntimeConfig(opts.config)
  const configPath = getConfigPath()
  const ws = getWorkspace(config)
  const model = getModel(config)

  console.log(`${chalk.cyan('jarvis')} Status`)
  console.log()
  console.log(`  Config:   ${configPath} ${existsSync(configPath) ? chalk.green('✓') : chalk.red('✗')}`)
  console.log(`  Workspace: ${ws} ${existsSync(ws) ? chalk.green('✓') : chalk.red('✗')}`)
  console.log(`  Model:    ${model}`)
  console.log()

  if (existsSync(configPath)) {
    for (const spec of PROVIDERS) {
      const providerName = spec.displayName || spec.name
      const p = (config.providers as Record<string, any>)?.[spec.name]
      if (!p) continue
      if (spec.isOAuth) {
        console.log(`  ${providerName}: ${chalk.green('✓')} (OAuth)`)
      } else if (spec.isLocal) {
        if (p.apiBase) {
          console.log(`  ${providerName}: ${chalk.green('✓')} ${p.apiBase}`)
        } else {
          console.log(`  ${providerName}: ${chalk.dim('not set')}`)
        }
      } else {
        const hasKey = !!p.apiKey
        console.log(`  ${providerName}: ${hasKey ? chalk.green('✓') : chalk.dim('not set')}`)
      }
    }
  }
}

// ===========================================================================
// Channels subcommands
// ===========================================================================

export async function cmdChannelsStatus(opts: { config?: string }): Promise<void> {
  loadRuntimeConfig(opts.config)

  console.log('Channel Status')
  console.log()

  try {
    const { discoverAll } = await import('../channels/registry')
    const allChannels = await discoverAll()

    for (const [name, cls] of Object.entries(allChannels)) {
      const displayName = (cls as any).displayName ?? name
      console.log(`  ${displayName}`)
    }
  } catch {
    console.log('  (No channel support available)')
  }
}

export async function cmdChannelsLogin(
  channelName: string,
  opts: { force?: boolean; config?: string },
): Promise<void> {
  loadRuntimeConfig(opts.config)

  try {
    const { discoverAll } = await import('../channels/registry')
    const allChannels: Record<string, new (...args: any[]) => any> = await discoverAll()

    if (!(channelName in allChannels)) {
      const available = Object.keys(allChannels).join(', ')
      console.error(chalk.red(`Unknown channel: ${channelName}`))
      console.error(`  Available: ${available}`)
      process.exit(1)
    }

    const cls = allChannels[channelName] as any
    console.log(`${chalk.cyan('jarvis')} ${cls.displayName ?? channelName} Login`)
    console.log()

    const instance = new cls({}, null)
    if (typeof instance.login === 'function') {
      await instance.login({ force: opts.force ?? false })
    } else {
      console.error(chalk.yellow(`Login not supported for ${channelName}`))
    }
  } catch {
    console.error(chalk.red('Channel support not available'))
  }
}

// ===========================================================================
// Plugins subcommand
// ===========================================================================

export async function cmdPluginsList(opts: { config?: string }): Promise<void> {
  const config = loadRuntimeConfig(opts.config)

  console.log('Channel Plugins')
  console.log()

  try {
    const { discoverAll, discoverChannelNames } = await import('../channels/registry')
    const builtinNames = new Set(discoverChannelNames())
    const allChannels = await discoverAll()

    for (const [name, cls] of Object.entries(allChannels)) {
      const displayName = (cls as any).displayName ?? name
      const source = builtinNames.has(name) ? 'builtin' : 'plugin'
      const section = (config.channels as Record<string, any>)?.[name]
      const enabled = section?.enabled ?? false
      const status = enabled ? chalk.green('yes') : chalk.dim('no')
      console.log(`  ${displayName} (${source}): ${status}`)
    }
  } catch {
    console.log('  (Plugin discovery not available)')
  }
}

// ===========================================================================
// Provider subcommand
// ===========================================================================

export async function cmdProviderLogin(providerName: string): Promise<void> {
  const key = providerName.replace(/-/g, '_')
  const spec = PROVIDERS.find((s: ProviderSpec) => s.name === key && s.isOAuth)
  if (!spec) {
    const oauthNames = PROVIDERS
      .filter((s: ProviderSpec) => s.isOAuth)
      .map((s: ProviderSpec) => s.name.replace(/_/g, '-'))
    console.error(chalk.red(`Unknown OAuth provider: ${providerName}`))
    console.error(`  Supported: ${oauthNames.join(', ')}`)
    return
  }

  console.log(`${chalk.cyan('jarvis')} OAuth Login - ${spec.displayName}`)
  console.log()

  // OAuth login handlers
  if (spec.name === 'openai_codex') {
    console.error(chalk.yellow('OpenAI Codex login not yet implemented.'))
    console.error('Set OPENAI_API_KEY env var or configure in config file.')
  } else if (spec.name === 'github_copilot') {
    console.error(chalk.yellow('GitHub Copilot login not yet implemented.'))
    console.error('Set GITHUB_TOKEN env var or configure in config file.')
  } else {
    console.error(chalk.red(`Login not implemented for ${spec.displayName}`))
  }
}
