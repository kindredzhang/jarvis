/**
 * DeepSeekProvider —— DeepSeek API 供应商（基于 OpenAICompatProvider）
 *
 * 继承 OpenAICompatProvider，仅设定默认的 model 和 baseUrl。
 * 所有核心逻辑由基类实现。
 *
 * ========= TODO: 与 nanobot 差异标注 =========
 * - DeepSeek 特有的 reasoning_content 字段已在基类 parseResponse 中处理
 * - DeepSeek 对中文 tool function.description 可能报错（已在上层标注意）
 */

import { OpenAICompatProvider, type OpenAICompatConfig } from './openai-compat'

export interface DeepSeekConfig extends OpenAICompatConfig {}

export class DeepSeekProvider extends OpenAICompatProvider {
  constructor(config: DeepSeekConfig) {
    super({
      apiKey: config.apiKey,
      model: config.model ?? 'deepseek-chat',
      baseUrl: config.baseUrl ?? 'https://api.deepseek.com/v1',
    })
  }
}
