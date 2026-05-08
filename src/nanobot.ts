/**
 * Nanobot — high-level programmatic interface to the jarvis agent.
 *
 * Port of nanobot/nanobot.py.
 *
 * Usage:
 *   const bot = Nanobot.fromConfig()
 *   const result = await bot.run("Summarize this repo")
 *   console.log(result.content)
 */

import { AgentLoop, type AgentLoopConfig } from './agent/loop'
import { loadConfig, type JarvisConfig } from './config'
import { findByName, findByModel, detectByBaseUrl } from './providers/registry'
import { AnthropicProvider } from './providers/anthropic'
import { OpenAICompatProvider } from './providers/openai-compat'
import { LLMProvider } from './providers/base'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ---- Result type ----

export interface RunResult {
  content: string
  toolsUsed: string[]
  messages: Record<string, unknown>[]
}

// ========================================================================
// Provider creation (port of _make_provider from nanobot/cli/commands.py)
// ========================================================================

/** Extract provider name from config (model-based auto-detection). */
function getProviderName(model: string, config: JarvisConfig): string {
  // Check if baseUrl matches a known provider
  const baseUrl = config.providers?.custom?.apiBase || undefined
  if (baseUrl) {
    const byBase = detectByBaseUrl(baseUrl)
    if (byBase) return byBase.name
  }
  // Match by model name keywords using registry (covers all 25+ providers)
  const byModel = findByModel(model)
  if (byModel) return byModel.spec.name
  return 'deepseek'
}

/** Resolve a config value with env var fallback. */
function fromEnvOrConfig(envVars: string[], configVal?: string | null): string {
  if (configVal) return configVal
  for (const ev of envVars) {
    const v = process.env[ev]
    if (v) return v
  }
  return ''
}

/** Create the appropriate LLM provider from config. */
export function makeProviderFromConfig(config: JarvisConfig): LLMProvider {
  const defaults = config.agents?.defaults
  const model = defaults?.model ?? 'deepseek-chat'
  const providerName = getProviderName(model, config)
  const spec = findByName(providerName)
  const backend = spec?.backend ?? 'openai_compat'

  // Resolve api_key and api_base: config per-provider > env var per-provider > JARVIS_API_KEY fallback
  const providerCfg = config.providers?.[providerName as keyof typeof config.providers] ?? config.providers?.custom
  const envVars: string[] = []
  if (spec?.envKey) envVars.push(spec.envKey)
  envVars.push('JARVIS_API_KEY')
  const apiKey = fromEnvOrConfig(
    envVars,
    (providerCfg as { apiKey?: string } | undefined)?.apiKey,
  )
  const baseUrl = (providerCfg as { apiBase?: string } | undefined)?.apiBase || spec?.defaultApiBase

  if (backend === 'anthropic') {
    return new AnthropicProvider({
      apiKey,
      model,
      baseUrl,
    })
  }

  // Default: OpenAI-compatible
  return new OpenAICompatProvider({
    apiKey,
    model,
    baseUrl,
  })
}

// ========================================================================
// Nanobot facade
// ========================================================================

/**
 * Programmatic facade for running the jarvis agent.
 *
 * Wraps AgentLoop setup, config loading, and provider creation so
 * that API consumers and scripts don't need to wire everything manually.
 */
export class Nanobot {
  private _loop: AgentLoop

  constructor(loop: AgentLoop) {
    this._loop = loop
  }

  /**
   * Create a Nanobot instance from a config file.
   *
   * @param configPath - Path to config file. Defaults to ~/.jarvis/config.json.
   * @param workspace - Override the workspace directory from config.
   */
  static fromConfig(configPath?: string, workspace?: string): Nanobot {
    const config = loadConfig(configPath)
    const defaults = config.agents?.defaults
    const ws = workspace || defaults?.workspace?.replace(/^~/, homedir()) || join(homedir(), '.jarvis')

    if (!existsSync(ws)) {
      mkdirSync(ws, { recursive: true })
    }

    const provider = makeProviderFromConfig(config)

    const loopConfig: AgentLoopConfig = {
      provider,
      workspace: ws,
      model: defaults?.model,
      maxIterations: defaults?.maxToolIterations,
      contextWindowTokens: defaults?.contextWindowTokens,
      maxToolResultChars: defaults?.maxToolResultChars,
      timezone: defaults?.timezone,
    }

    const loop = new AgentLoop(loopConfig)
    return new Nanobot(loop)
  }

  /**
   * Run the agent once and return the result.
   *
   * @param message - The user message to process.
   * @param sessionKey - Session identifier for conversation isolation.
   *   Different keys get independent history.
   */
  async run(
    message: string,
    sessionKey = 'sdk:default',
  ): Promise<RunResult> {
    const response = await this._loop.processDirect(message, {
      sessionKey,
    })

    const content = (response?.content) || ''
    return {
      content,
      toolsUsed: [],
      messages: [],
    }
  }

  /** Expose the underlying AgentLoop for advanced use. */
  get loop(): AgentLoop {
    return this._loop
  }

  /** Expose the provider. */
  get provider(): LLMProvider {
    return this._loop.provider
  }

  /** Expose the model name. */
  get model(): string {
    return this._loop.model
  }
}
