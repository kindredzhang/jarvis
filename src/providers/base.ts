/**
 * LLMProvider —— LLM 供应商抽象基类
 *
 * 所有供应商（DeepSeek、OpenAI、Anthropic 等）都继承此类。
 * 核心方法：
 * - generate(): 非流式生成
 * - generateStream(): 流式生成
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
