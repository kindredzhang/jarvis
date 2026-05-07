/**
 * JSON Schema 片段类型 —— 工具参数描述与约束
 *
 * 所有具体 Schema 类型继承自 Schema 基类，提供：
 * - toJsonSchema(): 返回兼容 validateJsonSchemaValue 的 JSON Schema 片段
 * - validateValue(value): 校验单个值，返回错误消息列表（空 = 合法）
 *
 * 参考 nanobot.agent.tools.base.Schema / nanobot.agent.tools.schema
 */

/** JSON Schema 原始类型 */
export interface JsonSchema {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  required?: string[]
  enum?: unknown[]
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  nullable?: boolean
  description?: string
  default?: unknown
  additionalProperties?: boolean | Record<string, unknown>
  [key: string]: unknown
}

// ---- Schema 基类 ----

export abstract class Schema {
  /** 从 JSON Schema type 中解析非 null 类型名（如 ['string', 'null'] → 'string'） */
  static resolveJsonSchemaType(t: string | string[] | undefined): string | undefined {
    if (Array.isArray(t)) {
      return t.find((x) => x !== 'null')
    }
    return t
  }

  /** 拼接嵌套路径 */
  static subpath(path: string, key: string): string {
    return path ? `${path}.${key}` : key
  }

  /**
   * 校验值是否符合 JSON Schema 片段
   * 返回错误消息数组，空数组表示合法
   */
  static validateJsonSchemaValue(
    val: unknown,
    schema: Record<string, unknown>,
    path = '',
  ): string[] {
    const rawType = schema.type as string | string[] | undefined
    const nullable = (Array.isArray(rawType) && rawType.includes('null')) || schema.nullable === true
    const t = Schema.resolveJsonSchemaType(rawType)
    const label = path || 'parameter'

    if (nullable && val === null) return []
    if (val === null) return [`${label} should be ${t ?? 'value'}`]

    // 类型检查
    if (t === 'integer') {
      if (typeof val !== 'number' || !Number.isInteger(val)) return [`${label} should be integer`]
    } else if (t === 'number') {
      if (typeof val !== 'number') return [`${label} should be number`]
    } else if (t === 'string') {
      if (typeof val !== 'string') return [`${label} should be string`]
    } else if (t === 'boolean') {
      if (typeof val !== 'boolean') return [`${label} should be boolean`]
    } else if (t === 'array') {
      if (!Array.isArray(val)) return [`${label} should be array`]
    } else if (t === 'object') {
      if (typeof val !== 'object' || val === null || Array.isArray(val)) return [`${label} should be object`]
    }

    const errors: string[] = []

    // 枚举约束
    if (schema.enum !== undefined && !(schema.enum as unknown[]).includes(val)) {
      errors.push(`${label} must be one of ${JSON.stringify(schema.enum)}`)
    }

    // 数值约束
    if (t === 'integer' || t === 'number') {
      const n = val as number
      if (typeof schema.minimum === 'number' && n < schema.minimum) {
        errors.push(`${label} must be >= ${schema.minimum}`)
      }
      if (typeof schema.maximum === 'number' && n > schema.maximum) {
        errors.push(`${label} must be <= ${schema.maximum}`)
      }
    }

    // 字符串约束
    if (t === 'string') {
      const s = val as string
      if (typeof schema.minLength === 'number' && s.length < schema.minLength) {
        errors.push(`${label} must be at least ${schema.minLength} chars`)
      }
      if (typeof schema.maxLength === 'number' && s.length > schema.maxLength) {
        errors.push(`${label} must be at most ${schema.maxLength} chars`)
      }
    }

    // 对象属性递归校验
    if (t === 'object' && typeof val === 'object' && val !== null && !Array.isArray(val)) {
      const obj = val as Record<string, unknown>
      const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
      const required = (schema.required ?? []) as string[]

      for (const key of required) {
        if (!(key in obj)) {
          errors.push(`missing required ${Schema.subpath(path, key)}`)
        }
      }

      for (const [key, valItem] of Object.entries(obj)) {
        if (key in props) {
          errors.push(...Schema.validateJsonSchemaValue(valItem, props[key], Schema.subpath(path, key)))
        }
      }
    }

    // 数组递归校验
    if (t === 'array' && Array.isArray(val)) {
      if (typeof schema.minItems === 'number' && val.length < schema.minItems) {
        errors.push(`${label} must have at least ${schema.minItems} items`)
      }
      if (typeof schema.maxItems === 'number' && val.length > schema.maxItems) {
        errors.push(`${label} must be at most ${schema.maxItems} items`)
      }
      if (schema.items && typeof schema.items === 'object') {
        const prefix = path ? `${path}[{}]` : '[{}]'
        for (let i = 0; i < val.length; i++) {
          errors.push(
            ...Schema.validateJsonSchemaValue(
              val[i],
              schema.items as Record<string, unknown>,
              prefix.replace('{}', String(i)),
            ),
          )
        }
      }
    }

    return errors
  }

  /**
   * 标准化 Schema 实例或 JSON Schema 字典为片段 dict
   * 用于 ArraySchema/ObjectSchema 中递归处理子 Schema
   */
  static fragment(value: Schema | Record<string, unknown>): Record<string, unknown> {
    if (value instanceof Schema) return value.toJsonSchema()
    if (typeof value === 'object' && value !== null) return value
    throw new TypeError(`Expected schema object or dict, got ${typeof value}`)
  }

  /** 返回 JSON Schema 片段 dict */
  abstract toJsonSchema(): Record<string, unknown>

  /** 校验单个值；返回错误消息列表（空 = 合法） */
  validateValue(value: unknown, path = ''): string[] {
    return Schema.validateJsonSchemaValue(value, this.toJsonSchema(), path)
  }
}

// ---- 具体 Schema 类型 ----

/** 字符串参数 */
export class StringSchema extends Schema {
  private description: string
  private minLength: number | undefined
  private maxLength: number | undefined
  private enum: unknown[] | undefined
  private nullable: boolean

  constructor(options: {
    description?: string
    minLength?: number
    maxLength?: number
    enum?: unknown[]
    nullable?: boolean
  } = {}) {
    super()
    this.description = options.description ?? ''
    this.minLength = options.minLength
    this.maxLength = options.maxLength
    this.enum = options.enum
    this.nullable = options.nullable ?? false
  }

  toJsonSchema(): Record<string, unknown> {
    const t: string | string[] = this.nullable ? ['string', 'null'] : 'string'
    const d: Record<string, unknown> = { type: t }
    if (this.description) d.description = this.description
    if (this.minLength !== undefined) d.minLength = this.minLength
    if (this.maxLength !== undefined) d.maxLength = this.maxLength
    if (this.enum !== undefined) d.enum = [...this.enum]
    return d
  }
}

/** 整数参数 */
export class IntegerSchema extends Schema {
  private description: string
  private minimum: number | undefined
  private maximum: number | undefined
  private enum: number[] | undefined
  private nullable: boolean

  constructor(options: {
    description?: string
    minimum?: number
    maximum?: number
    enum?: number[]
    nullable?: boolean
  } = {}) {
    super()
    this.description = options.description ?? ''
    this.minimum = options.minimum
    this.maximum = options.maximum
    this.enum = options.enum
    this.nullable = options.nullable ?? false
  }

  toJsonSchema(): Record<string, unknown> {
    const t: string | string[] = this.nullable ? ['integer', 'null'] : 'integer'
    const d: Record<string, unknown> = { type: t }
    if (this.description) d.description = this.description
    if (this.minimum !== undefined) d.minimum = this.minimum
    if (this.maximum !== undefined) d.maximum = this.maximum
    if (this.enum !== undefined) d.enum = [...this.enum]
    return d
  }
}

/** 浮点数参数 */
export class NumberSchema extends Schema {
  private description: string
  private minimum: number | undefined
  private maximum: number | undefined
  private enum: number[] | undefined
  private nullable: boolean

  constructor(options: {
    description?: string
    minimum?: number
    maximum?: number
    enum?: number[]
    nullable?: boolean
  } = {}) {
    super()
    this.description = options.description ?? ''
    this.minimum = options.minimum
    this.maximum = options.maximum
    this.enum = options.enum
    this.nullable = options.nullable ?? false
  }

  toJsonSchema(): Record<string, unknown> {
    const t: string | string[] = this.nullable ? ['number', 'null'] : 'number'
    const d: Record<string, unknown> = { type: t }
    if (this.description) d.description = this.description
    if (this.minimum !== undefined) d.minimum = this.minimum
    if (this.maximum !== undefined) d.maximum = this.maximum
    if (this.enum !== undefined) d.enum = [...this.enum]
    return d
  }
}

/** 布尔参数 */
export class BooleanSchema extends Schema {
  private description: string
  private default: boolean | undefined
  private nullable: boolean

  constructor(options: {
    description?: string
    default?: boolean
    nullable?: boolean
  } = {}) {
    super()
    this.description = options.description ?? ''
    this.default = options.default
    this.nullable = options.nullable ?? false
  }

  toJsonSchema(): Record<string, unknown> {
    const t: string | string[] = this.nullable ? ['boolean', 'null'] : 'boolean'
    const d: Record<string, unknown> = { type: t }
    if (this.description) d.description = this.description
    if (this.default !== undefined) d.default = this.default
    return d
  }
}

/** 数组参数 */
export class ArraySchema extends Schema {
  private itemsSchema: Schema | Record<string, unknown>
  private description: string
  private minItems: number | undefined
  private maxItems: number | undefined
  private nullable: boolean

  constructor(options: {
    items?: Schema | Record<string, unknown>
    description?: string
    minItems?: number
    maxItems?: number
    nullable?: boolean
  } = {}) {
    super()
    this.itemsSchema = options.items ?? new StringSchema()
    this.description = options.description ?? ''
    this.minItems = options.minItems
    this.maxItems = options.maxItems
    this.nullable = options.nullable ?? false
  }

  toJsonSchema(): Record<string, unknown> {
    const t: string | string[] = this.nullable ? ['array', 'null'] : 'array'
    const d: Record<string, unknown> = {
      type: t,
      items: Schema.fragment(this.itemsSchema),
    }
    if (this.description) d.description = this.description
    if (this.minItems !== undefined) d.minItems = this.minItems
    if (this.maxItems !== undefined) d.maxItems = this.maxItems
    return d
  }
}

/** 对象参数 */
export class ObjectSchema extends Schema {
  private properties: Record<string, Schema | Record<string, unknown>>
  private required: string[]
  private description: string
  private additionalProperties: boolean | Record<string, unknown> | undefined
  private nullable: boolean

  constructor(options: {
    properties?: Record<string, Schema | Record<string, unknown>>
    required?: string[]
    description?: string
    additionalProperties?: boolean | Record<string, unknown>
    nullable?: boolean
  } = {}) {
    super()
    this.properties = { ...(options.properties ?? {}) }
    this.required = [...(options.required ?? [])]
    this.description = options.description ?? ''
    this.additionalProperties = options.additionalProperties
    this.nullable = options.nullable ?? false
  }

  toJsonSchema(): Record<string, unknown> {
    const t: string | string[] = this.nullable ? ['object', 'null'] : 'object'
    const props: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(this.properties)) {
      props[k] = Schema.fragment(v)
    }
    const out: Record<string, unknown> = { type: t, properties: props }
    if (this.required.length > 0) out.required = [...this.required]
    if (this.description) out.description = this.description
    if (this.additionalProperties !== undefined) out.additionalProperties = this.additionalProperties
    return out
  }
}

/**
 * 构建根级工具参数 JSON Schema
 *
 * 替代 Python 版 tool_parameters_schema() 函数。
 *
 * @example
 * toolParametersSchema({
 *   required: ['name'],
 *   properties: {
 *     name: new StringSchema({ description: '用户名' }),
 *     age: new IntegerSchema({ description: '年龄', minimum: 0 }),
 *   },
 * })
 */
export function toolParametersSchema(options: {
  required?: string[]
  description?: string
  properties?: Record<string, Schema | Record<string, unknown>>
} = {}): Record<string, unknown> {
  return new ObjectSchema(options).toJsonSchema()
}
