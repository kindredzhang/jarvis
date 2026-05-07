/**
 * LLMProvider —— LLM 供应商抽象基类
 *
 * 所有供应商（DeepSeek、OpenAI、Anthropic 等）都继承此类。
 * 核心方法：
 * - generate(): 非流式生成
 * - generateStream(): 流式生成
 *
 * ========= TODO: 与 nanobot 差异标注 =========
 * 以下功能在 nanobot/providers/base.py 中存在，本文件暂未实现：
 * - 重试策略：LLMProvider._CHAT_RETRY_DELAYS, _PERSISTENT_MAX_DELAY 等
 * - 瞬态错误检测：_TRANSIENT_ERROR_MARKERS, _RETRYABLE_STATUS_CODES
 * - 429 错误细分：_NON_RETRYABLE_429 / _RETRYABLE_429 区分配额耗尽与限流
 * - 消息清洗：_sanitize_empty_content, _sanitize_request_messages
 * - 缓存控制：_apply_cache_control (prompt caching markers)
 * - 令牌用量追踪与统计
 * - finish_reason 细分：content_filter, refusal 等非标准原因
 */

import type { Message, LLMResponse, LLMResponseChunk, GenerationSettings } from './types'
import type { Tool } from '../agent/tools/base'

export abstract class LLMProvider {
  /** 模型名称 */
  abstract readonly model: string

  /**
   * 非流式生成
   * @param messages 消息列表
   * @param options 可选参数（工具、生成设置）
   */
  abstract generate(
    messages: Message[],
    options?: { tools?: Tool[]; settings?: GenerationSettings },
  ): Promise<LLMResponse>

  /**
   * 流式生成
   * 每次 yield 一个数据块，最后一个块的 finishReason 不为 null。
   */
  abstract generateStream(
    messages: Message[],
    options?: { tools?: Tool[]; settings?: GenerationSettings },
  ): AsyncIterable<LLMResponseChunk>
}
