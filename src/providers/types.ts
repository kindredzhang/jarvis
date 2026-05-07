/**
 * Provider 层类型定义
 */

/** LLM 工具调用请求 */
export interface ToolCallRequest {
  id: string
  type: 'function'
  function: {
    name: string
    /** JSON 字符串形式的参数 */
    arguments: string
  }
}

/** LLM 响应 */
export interface LLMResponse {
  /** 响应文本内容（可能为 null，如纯工具调用时） */
  content: string | null
  /** 结束原因 */
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error'
  /** 工具调用请求列表 */
  toolCalls: ToolCallRequest[]
  /** Token 用量 */
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  /** 思考过程（DeepSeek-R1 等模型输出） */
  reasoningContent?: string | null
}

/** LLM 响应流中的单个数据块 */
export interface LLMResponseChunk {
  content: string | null
  finishReason: string | null
  toolCalls: ToolCallRequest[]
}

/** 消息 */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /** 消息内容（assistant + tool_calls 时可 null） */
  content: string | null
  /** Assistant 消息中的工具调用 */
  toolCalls?: ToolCallRequest[]
  /** Tool 消息的工具调用 ID */
  toolCallId?: string
  /** 消息发送者名称 */
  name?: string
}

/** 生成参数 */
export interface GenerationSettings {
  temperature?: number
  maxTokens?: number
  reasoningEffort?: string | null
}
