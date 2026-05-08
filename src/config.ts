/**
 * 配置文件加载 —— 支持 JSON 文件 + 环境变量覆盖
 *
 * ========= TODO: 与 nanobot 差异标注 =========
 * - 支持 YAML 格式（依赖外部库）
 * - 多模型/多 Agent 配置
 * - 通道配置（feishu/discord/telegram）
 * - 工具行为配置（exec 白名单 / web 搜索等）
 * - 技能加载配置
 * - MCP 服务器配置
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface JarvisConfig {
  /** DeepSeek / LLM API Key */
  apiKey: string
  /** API 基础 URL */
  baseUrl?: string
  /** 模型名 */
  model?: string
  /** 工作区路径 */
  workspace?: string
  /** 最大 ReAct 迭代 */
  maxIterations?: number
  /** 上下文窗口 token */
  contextWindowTokens?: number
  /** 工具结果最大字符 */
  maxToolResultChars?: number
  /** 时区 */
  timezone?: string
}

const DEFAULT_CONFIG_PATHS = [
  './jarvis.json',
  join(homedir(), '.jarvis', 'config.json'),
]

/**
 * 加载配置：从 JSON 文件读取，环境变量覆盖
 *
 * 优先级（高 → 低）：
 * 1. 环境变量 JARVIS_* / DEEPSEEK_*
 * 2. 指定配置文件（--config）
 * 3. 默认路径查找
 * 4. 硬编码默认值
 */
export function loadConfig(configPath?: string): JarvisConfig {
  let config: Record<string, unknown> = {}

  // 尝试从配置文件读取
  const paths = configPath
    ? [configPath]
    : DEFAULT_CONFIG_PATHS

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, 'utf-8')
        config = { ...JSON.parse(raw), ...config }
      } catch (err) {
        console.warn(`[jarvis] Failed to read config ${p}: ${err}`)
      }
      break
    }
  }

  // 环境变量覆盖
  const envApiKey = process.env.DEEPSEEK_API_KEY || process.env.JARVIS_API_KEY
  const envBaseUrl = process.env.DEEPSEEK_BASE_URL || process.env.JARVIS_BASE_URL
  const envModel = process.env.JARVIS_MODEL
  const envWorkspace = process.env.JARVIS_WORKSPACE
  const envTimezone = process.env.JARVIS_TIMEZONE

  return {
    apiKey: envApiKey || (config.apiKey as string) || '',
    baseUrl: envBaseUrl || (config.baseUrl as string) || 'https://api.deepseek.com/v1',
    model: envModel || (config.model as string) || 'deepseek-chat',
    workspace: envWorkspace || (config.workspace as string) || join(homedir(), '.jarvis'),
    maxIterations: config.maxIterations as number | undefined,
    contextWindowTokens: config.contextWindowTokens as number | undefined,
    maxToolResultChars: config.maxToolResultChars as number | undefined,
    timezone: envTimezone || (config.timezone as string) || 'UTC',
  }
}
