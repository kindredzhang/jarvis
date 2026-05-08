/**
 * Configuration schema — port of nanobot/config/schema.py
 *
 * All interfaces use camelCase keys and accept the JSON keys used in config
 * files (camelCase by convention, snake_case also accepted during loading).
 */

import { homedir } from 'node:os'

// ========================================================================
// Channels
// ========================================================================

export interface ChannelCommonConfig {
  sendProgress?: boolean
  sendToolHints?: boolean
  sendMaxRetries?: number
  transcriptionProvider?: string
  transcriptionLanguage?: string
  /** Per-channel configs stored as extra string-keyed records */
  [channel: string]: unknown
}

// ========================================================================
// Dream (memory consolidation)
// ========================================================================

export interface DreamConfig {
  intervalH?: number
  cron?: string
  modelOverride?: string
  maxBatchSize?: number
  maxIterations?: number
  annotateLineAges?: boolean
}

// ========================================================================
// Agent Defaults
// ========================================================================

export interface AgentDefaultsConfig {
  workspace?: string
  model?: string
  provider?: string
  maxTokens?: number
  contextWindowTokens?: number
  contextBlockLimit?: number | null
  temperature?: number
  maxToolIterations?: number
  maxToolResultChars?: number
  providerRetryMode?: 'standard' | 'persistent'
  reasoningEffort?: string | null
  timezone?: string
  unifiedSession?: boolean
  disabledSkills?: string[]
  idleCompactAfterMinutes?: number
  dream?: DreamConfig
}

// ========================================================================
// Providers
// ========================================================================

export interface ProviderConfig {
  apiKey?: string | null
  apiBase?: string | null
  extraHeaders?: Record<string, string> | null
}

export interface ProvidersConfig {
  custom?: ProviderConfig
  azureOpenai?: ProviderConfig
  anthropic?: ProviderConfig
  openai?: ProviderConfig
  openrouter?: ProviderConfig
  deepseek?: ProviderConfig
  groq?: ProviderConfig
  zhipu?: ProviderConfig
  dashscope?: ProviderConfig
  vllm?: ProviderConfig
  ollama?: ProviderConfig
  lmStudio?: ProviderConfig
  ovms?: ProviderConfig
  gemini?: ProviderConfig
  moonshot?: ProviderConfig
  minimax?: ProviderConfig
  minimaxAnthropic?: ProviderConfig
  mistral?: ProviderConfig
  stepfun?: ProviderConfig
  xiaomiMimo?: ProviderConfig
  aihubmix?: ProviderConfig
  siliconflow?: ProviderConfig
  volcengine?: ProviderConfig
  volcengineCodingPlan?: ProviderConfig
  byteplus?: ProviderConfig
  byteplusCodingPlan?: ProviderConfig
  openaiCodex?: ProviderConfig
  githubCopilot?: ProviderConfig
  qianfan?: ProviderConfig
}

// ========================================================================
// Heartbeat
// ========================================================================

export interface HeartbeatConfig {
  enabled?: boolean
  intervalS?: number
  keepRecentMessages?: number
}

// ========================================================================
// API / Gateway
// ========================================================================

export interface ApiConfig {
  host?: string
  port?: number
  timeout?: number
}

export interface GatewayConfig {
  host?: string
  port?: number
  heartbeat?: HeartbeatConfig
}

// ========================================================================
// Tools
// ========================================================================

export interface WebSearchConfig {
  provider?: string
  apiKey?: string
  baseUrl?: string
  maxResults?: number
  timeout?: number
}

export interface WebToolsConfig {
  enable?: boolean
  proxy?: string | null
  search?: WebSearchConfig
}

export interface ExecToolConfig {
  enable?: boolean
  timeout?: number
  pathAppend?: string
  sandbox?: string
  allowedEnvKeys?: string[]
}

export interface MCPServerConfig {
  type?: 'stdio' | 'sse' | 'streamableHttp' | null
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  toolTimeout?: number
  enabledTools?: string[]
}

export interface MyToolConfig {
  enable?: boolean
  allowSet?: boolean
}

export interface ToolsConfig {
  web?: WebToolsConfig
  exec?: ExecToolConfig
  my?: MyToolConfig
  restrictToWorkspace?: boolean
  mcpServers?: Record<string, MCPServerConfig>
  ssrfWhitelist?: string[]
}

// ========================================================================
// Root
// ========================================================================

export interface JarvisConfig {
  agents?: { defaults?: AgentDefaultsConfig }
  channels?: ChannelCommonConfig
  providers?: ProvidersConfig
  api?: ApiConfig
  gateway?: GatewayConfig
  tools?: ToolsConfig
}

/** Default configuration values */
export const DEFAULTS: JarvisConfig = {
  agents: {
    defaults: {
      workspace: homedir() + '/.jarvis',
      model: 'deepseek-chat',
      provider: 'auto',
      maxTokens: 8192,
      contextWindowTokens: 65536,
      temperature: 0.1,
      maxToolIterations: 200,
      maxToolResultChars: 16000,
      providerRetryMode: 'standard',
      timezone: 'UTC',
      unifiedSession: false,
      disabledSkills: [],
      idleCompactAfterMinutes: 0,
      dream: {
        intervalH: 2,
        maxBatchSize: 20,
        maxIterations: 15,
        annotateLineAges: true,
      },
    },
  },
  channels: {
    sendProgress: true,
    sendToolHints: false,
    sendMaxRetries: 3,
  },
  api: {
    host: '127.0.0.1',
    port: 8900,
    timeout: 120,
  },
  gateway: {
    host: '127.0.0.1',
    port: 18790,
    heartbeat: {
      enabled: true,
      intervalS: 1800,
      keepRecentMessages: 8,
    },
  },
  tools: {
    web: {
      enable: true,
      search: {
        provider: 'duckduckgo',
        apiKey: '',
        baseUrl: '',
        maxResults: 5,
        timeout: 30,
      },
    },
    exec: {
      enable: true,
      timeout: 60,
      pathAppend: '',
      sandbox: '',
      allowedEnvKeys: [],
    },
    my: {
      enable: true,
      allowSet: false,
    },
    restrictToWorkspace: false,
    mcpServers: {},
    ssrfWhitelist: [],
  },
}
