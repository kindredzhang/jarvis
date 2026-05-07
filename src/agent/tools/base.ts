/**
 * Tool 抽象基类 —— Agent 工具定义
 *
 * 所有工具都继承此类，实现 name/description/parameters/execute。
 * 可选的 readOnly / concurrencySafe / exclusive 属性控制并发行为。
 */

import { Schema, type JsonSchema } from './schema'

/** OpenAI 工具定义格式 */
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/**
 * 类型安全的类型映射（与 JSON Schema type → TS type 对照）
 */
const TYPE_MAP: Record<string, 'string' | 'number' | 'boolean' | 'object'> = {
  string: 'string',
  integer: 'number',
  number: 'number',
  boolean: 'boolean',
  array: 'object',
  object: 'object',
} as const

const BOOL_TRUE = new Set(['true', '1', 'yes'])
const BOOL_FALSE = new Set(['false', '0', 'no'])

export abstract class Tool {
  /** 工具名称（用于 LLM function calling） */
  abstract readonly name: string

  /** 工具描述 */
  abstract readonly description: string

  /** JSON Schema 定义的工具参数 */
  abstract readonly parameters: Record<string, unknown>

  /** 是否为只读工具（无副作用，可并行） */
  get readOnly(): boolean {
    return false
  }

  /** 是否可与其他并发安全工具同时运行 */
  get concurrencySafe(): boolean {
    return this.readOnly && !this.exclusive
  }

  /** 是否应独占运行（即使并发已启用） */
  get exclusive(): boolean {
    return false
  }

  /** 执行工具逻辑 */
  abstract execute(args: Record<string, unknown>): Promise<unknown>

  /**
   * 基于 Schema 进行类型转换
   * LLM 返回的参数有时类型不准确（如数字变成字符串），此方法做容错转换
   */
  castParams(params: Record<string, unknown>): Record<string, unknown> {
    const schema = (this.parameters ?? {}) as JsonSchema
    if (schema.type !== 'object') return params
    return this.castObject(params, schema)
  }

  /** 校验参数 -> 返回错误列表（空数组 = 合法） */
  validateParams(params: Record<string, unknown>): string[] {
    if (typeof params !== 'object' || params === null) {
      return [`parameters must be an object, got ${typeof params}`]
    }
    const schema = (this.parameters ?? {}) as JsonSchema
    return Schema.validateJsonSchemaValue(params, { ...schema, type: 'object' })
  }

  /** 转换为 OpenAI 工具定义格式 */
  toSchema(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: this.parameters,
      },
    }
  }

  // ---- 内部类型转换 ----

  private castObject(obj: Record<string, unknown>, schema: JsonSchema): Record<string, unknown> {
    if (typeof obj !== 'object' || obj === null) return obj
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(obj)) {
      result[key] = key in props ? this.castValue(val, props[key]!) : val
    }
    return result
  }

  private castValue(val: unknown, schema: JsonSchema): unknown {
    const t = Schema.resolveJsonSchemaType(schema.type as string | string[] | undefined)

    // 已经是正确类型，直接返回
    if (t === 'boolean' && typeof val === 'boolean') return val
    if (t === 'integer' && typeof val === 'number' && Number.isInteger(val)) return val
    if (t === 'number' && typeof val === 'number') return val
    if (t === 'string' && typeof val === 'string') return val
    if (t === 'string' && val === null) return null

    // 字符串 → 数字
    if (typeof val === 'string' && (t === 'integer' || t === 'number')) {
      const parsed = t === 'integer' ? Number.parseInt(val, 10) : Number.parseFloat(val)
      if (!Number.isNaN(parsed)) return parsed
      return val
    }

    // 转字符串
    if (t === 'string') {
      return String(val)
    }

    // 字符串 → 布尔
    if (typeof val === 'string' && t === 'boolean') {
      const low = val.toLowerCase()
      if (BOOL_TRUE.has(low)) return true
      if (BOOL_FALSE.has(low)) return false
      return val
    }

    // 数组递归转换
    if (t === 'array' && Array.isArray(val) && schema.items) {
      return val.map((item) => this.castValue(item, schema.items as JsonSchema))
    }

    // 对象递归转换
    if (t === 'object' && typeof val === 'object' && val !== null && !Array.isArray(val)) {
      return this.castObject(val as Record<string, unknown>, schema)
    }

    return val
  }
}

/**
 * 定义工具参数的辅助函数
 *
 * 替代 Python 版 @tool_parameters 装饰器。
 * 用法：在 constructor 中调用，或直接覆盖 get parameters()
 *
 * @example
 * class MyTool extends Tool {
 *   readonly name = 'my_tool'
 *   readonly description = 'Does something'
 *   readonly parameters = defineParams({
 *     type: 'object',
 *     properties: { path: { type: 'string' } },
 *     required: ['path'],
 *   })
 *   async execute(args: Record<string, unknown>) { ... }
 * }
 */
export function defineParams(schema: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema))
}
