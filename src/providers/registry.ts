/**
 * ProviderRegistry — single source of truth for LLM provider metadata.
 *
 * Port of nanobot/providers/registry.py. Adding a provider:
 *  1. Add a ProviderSpec to PROVIDERS below.
 *  2. Add a field to ProvidersConfig in config/schema.py.
 *  Done. Env vars, config matching, status display all derive from here.
 *
 * Order matters — it controls match priority and fallback.
 * Gateways first so they win in fallback routing.
 */

export interface ProviderSpec {
  /** Config field name, e.g. "dashscope" */
  name: string
  /** Model-name keywords for matching (lowercase) */
  keywords: string[]
  /** Env var for API key, e.g. "DASHSCOPE_API_KEY" */
  envKey: string
  /** Human-readable display name */
  displayName: string

  /** Which provider implementation to use:
   *  "openai_compat" | "anthropic" | "azure_openai" | "openai_codex" | "github_copilot" */
  backend: string

  /** Extra env vars, e.g. [("ZHIPUAI_API_KEY", "{api_key}")] */
  envExtras?: [string, string][]

  /** Routes any model (OpenRouter, AiHubMix) */
  isGateway?: boolean
  /** Local deployment (vLLM, Ollama) */
  isLocal?: boolean
  /** Match api_key prefix, e.g. "sk-or-" */
  detectByKeyPrefix?: string
  /** Match substring in api_base URL */
  detectByBaseKeyword?: string
  /** OpenAI-compatible base URL for this provider */
  defaultApiBase?: string

  /** Strip "provider/" before sending to gateway */
  stripModelPrefix?: boolean
  supportsMaxCompletionTokens?: boolean

  /** Per-model param overrides, e.g. [("kimi-k2.5", {temperature: 1.0})] */
  modelOverrides?: [string, Record<string, unknown>][]

  /** OAuth-based providers (OpenAI Codex) don't use API keys */
  isOAuth?: boolean
  /** Direct providers skip API-key validation */
  isDirect?: boolean

  /** Provider supports cache_control on content blocks (Anthropic prompt caching) */
  supportsPromptCaching?: boolean

  /** How to inject the thinking on/off toggle into extra_body.
   *  ""               — no extra_body needed (default)
   *  "thinking_type"  — {thinking: {type: "enabled"/"disabled"}} (DeepSeek, VolcEngine)
   *  "enable_thinking" — {enable_thinking: true/false} (DashScope)
   *  "reasoning_split" — {reasoning_split: true/false} (MiniMax) */
  thinkingStyle?: string
}

function spec(opts: Omit<ProviderSpec, 'displayName'> & { displayName?: string }): ProviderSpec {
  return {
    displayName: opts.displayName || opts.name.charAt(0).toUpperCase() + opts.name.slice(1),
    ...opts,
  }
}

// ---------------------------------------------------------------------------
// PROVIDERS — the registry. Order = priority.
// ---------------------------------------------------------------------------

export const PROVIDERS: readonly ProviderSpec[] = [
  // === Custom (direct OpenAI-compatible endpoint) ========================
  spec({
    name: 'custom',
    keywords: [],
    envKey: '',
    backend: 'openai_compat',
    isDirect: true,
  }),

  // === Azure OpenAI =====================================================
  spec({
    name: 'azure_openai',
    keywords: ['azure', 'azure-openai'],
    envKey: '',
    displayName: 'Azure OpenAI',
    backend: 'azure_openai',
    isDirect: true,
  }),

  // === Gateways (detected by api_key / api_base) =========================
  // OpenRouter: keys start with "sk-or-"
  spec({
    name: 'openrouter',
    keywords: ['openrouter'],
    envKey: 'OPENROUTER_API_KEY',
    displayName: 'OpenRouter',
    backend: 'openai_compat',
    isGateway: true,
    detectByKeyPrefix: 'sk-or-',
    detectByBaseKeyword: 'openrouter',
    defaultApiBase: 'https://openrouter.ai/api/v1',
    supportsPromptCaching: true,
  }),

  // AiHubMix
  spec({
    name: 'aihubmix',
    keywords: ['aihubmix'],
    envKey: 'OPENAI_API_KEY',
    displayName: 'AiHubMix',
    backend: 'openai_compat',
    isGateway: true,
    detectByBaseKeyword: 'aihubmix',
    defaultApiBase: 'https://aihubmix.com/v1',
    stripModelPrefix: true,
  }),

  // SiliconFlow (硅基流动)
  spec({
    name: 'siliconflow',
    keywords: ['siliconflow'],
    envKey: 'OPENAI_API_KEY',
    displayName: 'SiliconFlow',
    backend: 'openai_compat',
    isGateway: true,
    detectByBaseKeyword: 'siliconflow',
    defaultApiBase: 'https://api.siliconflow.cn/v1',
  }),

  // VolcEngine (火山引擎)
  spec({
    name: 'volcengine',
    keywords: ['volcengine', 'volces', 'ark'],
    envKey: 'OPENAI_API_KEY',
    displayName: 'VolcEngine',
    backend: 'openai_compat',
    isGateway: true,
    detectByBaseKeyword: 'volces',
    defaultApiBase: 'https://ark.cn-beijing.volces.com/api/v3',
    thinkingStyle: 'thinking_type',
  }),

  // VolcEngine Coding Plan
  spec({
    name: 'volcengine_coding_plan',
    keywords: ['volcengine-plan'],
    envKey: 'OPENAI_API_KEY',
    displayName: 'VolcEngine Coding Plan',
    backend: 'openai_compat',
    isGateway: true,
    defaultApiBase: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    stripModelPrefix: true,
    thinkingStyle: 'thinking_type',
  }),

  // BytePlus
  spec({
    name: 'byteplus',
    keywords: ['byteplus'],
    envKey: 'OPENAI_API_KEY',
    displayName: 'BytePlus',
    backend: 'openai_compat',
    isGateway: true,
    detectByBaseKeyword: 'bytepluses',
    defaultApiBase: 'https://ark.ap-southeast.bytepluses.com/api/v3',
    stripModelPrefix: true,
    thinkingStyle: 'thinking_type',
  }),

  // BytePlus Coding Plan
  spec({
    name: 'byteplus_coding_plan',
    keywords: ['byteplus-plan'],
    envKey: 'OPENAI_API_KEY',
    displayName: 'BytePlus Coding Plan',
    backend: 'openai_compat',
    isGateway: true,
    defaultApiBase: 'https://ark.ap-southeast.bytepluses.com/api/coding/v3',
    stripModelPrefix: true,
    thinkingStyle: 'thinking_type',
  }),

  // === Standard providers (matched by model-name keywords) ===============
  // Anthropic
  spec({
    name: 'anthropic',
    keywords: ['anthropic', 'claude'],
    envKey: 'ANTHROPIC_API_KEY',
    displayName: 'Anthropic',
    backend: 'anthropic',
    supportsPromptCaching: true,
  }),

  // OpenAI
  spec({
    name: 'openai',
    keywords: ['openai', 'gpt'],
    envKey: 'OPENAI_API_KEY',
    displayName: 'OpenAI',
    backend: 'openai_compat',
    supportsMaxCompletionTokens: true,
  }),

  // OpenAI Codex (OAuth-based)
  spec({
    name: 'openai_codex',
    keywords: ['openai-codex'],
    envKey: '',
    displayName: 'OpenAI Codex',
    backend: 'openai_codex',
    detectByBaseKeyword: 'codex',
    defaultApiBase: 'https://chatgpt.com/backend-api',
    isOAuth: true,
  }),

  // GitHub Copilot (OAuth-based)
  spec({
    name: 'github_copilot',
    keywords: ['github_copilot', 'copilot'],
    envKey: '',
    displayName: 'Github Copilot',
    backend: 'github_copilot',
    defaultApiBase: 'https://api.githubcopilot.com',
    stripModelPrefix: true,
    isOAuth: true,
    supportsMaxCompletionTokens: true,
  }),

  // DeepSeek
  spec({
    name: 'deepseek',
    keywords: ['deepseek'],
    envKey: 'DEEPSEEK_API_KEY',
    displayName: 'DeepSeek',
    backend: 'openai_compat',
    defaultApiBase: 'https://api.deepseek.com',
    thinkingStyle: 'thinking_type',
  }),

  // Gemini
  spec({
    name: 'gemini',
    keywords: ['gemini'],
    envKey: 'GEMINI_API_KEY',
    displayName: 'Gemini',
    backend: 'openai_compat',
    defaultApiBase: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  }),

  // Zhipu (智谱)
  spec({
    name: 'zhipu',
    keywords: ['zhipu', 'glm', 'zai'],
    envKey: 'ZAI_API_KEY',
    displayName: 'Zhipu AI',
    backend: 'openai_compat',
    envExtras: [['ZHIPUAI_API_KEY', '{api_key}']],
    defaultApiBase: 'https://open.bigmodel.cn/api/paas/v4',
  }),

  // DashScope (通义千问)
  spec({
    name: 'dashscope',
    keywords: ['qwen', 'dashscope'],
    envKey: 'DASHSCOPE_API_KEY',
    displayName: 'DashScope',
    backend: 'openai_compat',
    defaultApiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    thinkingStyle: 'enable_thinking',
  }),

  // Moonshot (月之暗面 / Kimi)
  spec({
    name: 'moonshot',
    keywords: ['moonshot', 'kimi'],
    envKey: 'MOONSHOT_API_KEY',
    displayName: 'Moonshot',
    backend: 'openai_compat',
    defaultApiBase: 'https://api.moonshot.ai/v1',
    modelOverrides: [
      ['kimi-k2.5', { temperature: 1.0 }],
      ['kimi-k2.6', { temperature: 1.0 }],
    ],
  }),

  // MiniMax
  spec({
    name: 'minimax',
    keywords: ['minimax'],
    envKey: 'MINIMAX_API_KEY',
    displayName: 'MiniMax',
    backend: 'openai_compat',
    defaultApiBase: 'https://api.minimax.io/v1',
    thinkingStyle: 'reasoning_split',
  }),

  // MiniMax Anthropic-compatible endpoint
  spec({
    name: 'minimax_anthropic',
    keywords: ['minimax_anthropic'],
    envKey: 'MINIMAX_API_KEY',
    displayName: 'MiniMax (Anthropic)',
    backend: 'anthropic',
    defaultApiBase: 'https://api.minimax.io/anthropic',
  }),

  // Mistral AI
  spec({
    name: 'mistral',
    keywords: ['mistral'],
    envKey: 'MISTRAL_API_KEY',
    displayName: 'Mistral',
    backend: 'openai_compat',
    defaultApiBase: 'https://api.mistral.ai/v1',
  }),

  // Step Fun (阶跃星辰)
  spec({
    name: 'stepfun',
    keywords: ['stepfun', 'step'],
    envKey: 'STEPFUN_API_KEY',
    displayName: 'Step Fun',
    backend: 'openai_compat',
    defaultApiBase: 'https://api.stepfun.com/v1',
  }),

  // Xiaomi MIMO (小米)
  spec({
    name: 'xiaomi_mimo',
    keywords: ['xiaomi_mimo', 'mimo'],
    envKey: 'XIAOMIMIMO_API_KEY',
    displayName: 'Xiaomi MIMO',
    backend: 'openai_compat',
    defaultApiBase: 'https://api.xiaomimimo.com/v1',
  }),

  // === Local deployment ==================================================
  // vLLM / any OpenAI-compatible local server
  spec({
    name: 'vllm',
    keywords: ['vllm'],
    envKey: 'HOSTED_VLLM_API_KEY',
    displayName: 'vLLM/Local',
    backend: 'openai_compat',
    isLocal: true,
  }),

  // Ollama (local)
  spec({
    name: 'ollama',
    keywords: ['ollama', 'nemotron'],
    envKey: 'OLLAMA_API_KEY',
    displayName: 'Ollama',
    backend: 'openai_compat',
    isLocal: true,
    detectByBaseKeyword: '11434',
    defaultApiBase: 'http://localhost:11434/v1',
  }),

  // LM Studio (local)
  spec({
    name: 'lm_studio',
    keywords: ['lm-studio', 'lmstudio', 'lm_studio'],
    envKey: 'LM_STUDIO_API_KEY',
    displayName: 'LM Studio',
    backend: 'openai_compat',
    isLocal: true,
    detectByBaseKeyword: '1234',
    defaultApiBase: 'http://localhost:1234/v1',
  }),

  // OpenVINO Model Server (direct, local)
  spec({
    name: 'ovms',
    keywords: ['openvino', 'ovms'],
    envKey: '',
    displayName: 'OpenVINO Model Server',
    backend: 'openai_compat',
    isDirect: true,
    isLocal: true,
    defaultApiBase: 'http://localhost:8000/v3',
  }),

  // === Auxiliary =========================================================
  // Groq (mainly Whisper transcription)
  spec({
    name: 'groq',
    keywords: ['groq'],
    envKey: 'GROQ_API_KEY',
    displayName: 'Groq',
    backend: 'openai_compat',
    defaultApiBase: 'https://api.groq.com/openai/v1',
  }),

  // Qianfan (百度千帆)
  spec({
    name: 'qianfan',
    keywords: ['qianfan', 'ernie'],
    envKey: 'QIANFAN_API_KEY',
    displayName: 'Qianfan',
    backend: 'openai_compat',
    defaultApiBase: 'https://qianfan.baidubce.com/v2',
  }),
]

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Find a provider spec by config field name, e.g. "dashscope".
 */
export function findByName(name: string): ProviderSpec | undefined {
  const normalized = name.replace(/-/g, '_').toLowerCase()
  return PROVIDERS.find((s) => s.name === normalized)
}

/**
 * Find a provider spec by model name keyword matching.
 * Checks if any of the spec's keywords appear in the model name.
 */
export function findByModel(model: string): { spec: ProviderSpec; confidence: number } | undefined {
  const ml = model.toLowerCase()
  let best: { spec: ProviderSpec; confidence: number } | undefined

  for (const s of PROVIDERS) {
    for (const kw of s.keywords) {
      if (ml.includes(kw)) {
        const confidence = kw.length / ml.length
        if (!best || confidence > best.confidence) {
          best = { spec: s, confidence }
        }
        break
      }
    }
  }

  return best
}

/**
 * Detect provider by API key prefix.
 */
export function detectByApiKey(apiKey: string): ProviderSpec | undefined {
  return PROVIDERS.find((s) => s.detectByKeyPrefix && apiKey.startsWith(s.detectByKeyPrefix))
}

/**
 * Detect provider by API base URL keyword.
 */
export function detectByBaseUrl(baseUrl: string): ProviderSpec | undefined {
  const bl = baseUrl.toLowerCase()
  return PROVIDERS.find((s) => s.detectByBaseKeyword && bl.includes(s.detectByBaseKeyword))
}
