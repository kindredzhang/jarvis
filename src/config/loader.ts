/**
 * Configuration loading — port of original Python project
 *
 * Loads JSON config from file, applies migration, resolves ${VAR} env vars.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { type JarvisConfig, DEFAULTS } from './schema'
import { configureSSRFWhitelist } from '../security/network'

// Current config path for multi-instance support
let _currentConfigPath: string | null = null

export function setConfigPath(path: string): void {
  _currentConfigPath = path
}

export function getConfigPath(): string {
  return _currentConfigPath || homedir() + '/.jarvis/config.json'
}

// Default search paths when no explicit configPath given
const DEFAULT_CONFIG_PATHS: string[] = [
  './jarvis.json',
  homedir() + '/.jarvis/config.json',
]

/**
 * Load configuration from file or create default.
 */
export function loadConfig(configPath?: string): JarvisConfig {
  const path = configPath || getConfigPath()
  const config: JarvisConfig = deepClone(DEFAULTS)

  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf-8')
      const data = JSON.parse(raw)
      const migrated = migrateConfig(data)
      deepMerge(config as unknown as Record<string, unknown>, migrated as unknown as Record<string, unknown>)
    } catch (e) {
      console.warn(`[config] Failed to load config from ${path}: ${e}`)
      console.warn('[config] Using default configuration.')
    }
  } else {
    // Fall back to default search paths
    for (const p of DEFAULT_CONFIG_PATHS) {
      if (existsSync(p) && p !== path) {
        try {
          const raw = readFileSync(p, 'utf-8')
          const data = JSON.parse(raw)
          const migrated = migrateConfig(data)
          deepMerge(config as unknown as Record<string, unknown>, migrated as unknown as Record<string, unknown>)
        } catch { /* skip */ }
        break
      }
    }
  }

  // Resolve ${VAR} env var references
  resolveConfigEnvVars(config)

  // Apply SSRF whitelist
  const whitelist = config.tools?.ssrfWhitelist
  if (whitelist && whitelist.length > 0) {
    configureSSRFWhitelist(whitelist)
  }

  return config
}

/**
 * Save configuration to file.
 */
export function saveConfig(config: JarvisConfig, configPath?: string): void {
  const path = configPath || getConfigPath()
  const dir = path.substring(0, path.lastIndexOf('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf-8')
}

// ---- Env var resolution ----

const ENV_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/

function resolveConfigEnvVars(config: JarvisConfig): void {
  walkAndResolve(config)
}

function walkAndResolve(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(ENV_REF_RE, (_match, name: string) => {
      const value = process.env[name]
      if (value === undefined) {
        throw new Error(
          `Environment variable '${name}' referenced in config is not set`
        )
      }
      return value
    })
  }
  if (obj && typeof obj === 'object') {
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      ;(obj as Record<string, unknown>)[key] = walkAndResolve(
        (obj as Record<string, unknown>)[key]
      )
    }
  }
  return obj
}

// ---- Migration ----

function migrateConfig(data: Record<string, unknown>): Record<string, unknown> {
  // Move tools.exec.restrictToWorkspace → tools.restrictToWorkspace
  const tools = (data.tools as Record<string, unknown> | undefined) ?? {}
  const execCfg = (tools.exec as Record<string, unknown> | undefined) ?? {}
  if ('restrictToWorkspace' in execCfg && !('restrictToWorkspace' in tools)) {
    tools.restrictToWorkspace = execCfg.restrictToWorkspace
    delete execCfg.restrictToWorkspace
  }

  // Support flat/simple config format: { apiKey, model, baseUrl, workspace }
  // Migrate root-level keys into the proper nested structure
  if ('apiKey' in data || 'baseUrl' in data) {
    const flatKey = data.apiKey as string | undefined
    const flatBaseUrl = data.baseUrl as string | undefined
    const flatModel = data.model as string | undefined

    if (flatModel) {
      const agents = (data.agents as Record<string, unknown>) ?? {}
      const defaults = (agents.defaults as Record<string, unknown>) ?? {}
      if (!defaults.model) defaults.model = flatModel
      agents.defaults = defaults
      data.agents = agents
    }

    if (flatKey || flatBaseUrl) {
      const ml = (flatModel ?? 'deepseek-chat').toLowerCase()
      let pName = 'deepseek'
      if (ml.includes('claude')) pName = 'anthropic'
      else if (ml.includes('gpt')) pName = 'openai'
      else if (ml.includes('gemini')) pName = 'gemini'
      else if (ml.includes('glm') || ml.includes('zhipu')) pName = 'zhipu'
      else if (ml.includes('minimax')) pName = 'minimax'

      const providers = (data.providers as Record<string, unknown>) ?? {}
      const pCfg = (providers[pName] as Record<string, unknown>) ?? {}
      if (flatKey && !pCfg.apiKey) pCfg.apiKey = flatKey
      if (flatBaseUrl && !pCfg.apiBase) pCfg.apiBase = flatBaseUrl
      providers[pName] = pCfg
      data.providers = providers
    }
  }
  delete data.apiKey
  delete data.model
  delete data.baseUrl

  // Move tools.myEnabled / tools.mySet → tools.my.{enable, allowSet}
  if ('myEnabled' in tools || 'mySet' in tools) {
    const myCfg = (tools.my as Record<string, unknown>) ?? {}
    if ('myEnabled' in tools && !('enable' in myCfg)) {
      myCfg.enable = tools.myEnabled
    }
    delete tools.myEnabled
    if ('mySet' in tools && !('allowSet' in myCfg)) {
      myCfg.allowSet = tools.mySet
    }
    delete tools.mySet
    tools.my = myCfg
  }

  // Normalize provider keys (snake_case → camelCase)
  const providers = (data.providers as Record<string, unknown> | undefined)
  if (providers) {
    for (const [key, val] of Object.entries(providers)) {
      const camelKey = snakeToCamel(key)
      if (camelKey !== key) {
        providers[camelKey] = val
        delete providers[key]
      }
    }
  }

  data.tools = tools
  return data
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_m, c) => c.toUpperCase())
}

// ---- Deep merge ----

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj))
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    const srcVal = source[key]
    const tgtVal = target[key]
    if (
      srcVal !== null &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === 'object' &&
      !Array.isArray(tgtVal)
    ) {
      deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>)
    } else if (srcVal !== undefined) {
      target[key] = srcVal
    }
  }
}
