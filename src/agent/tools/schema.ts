/**
 * JSON Schema 运行时校验工具
 *
 * 用于校验 LLM 工具调用参数的合法性。
 * 不在编译期做校验——运行期拦截非法参数比让 LLM 产生奇怪错误更友好。
 */

/** JSON Schema 类型 */
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
  [key: string]: unknown
}

/** 从 JSON Schema type 中解析非 null 类型名（如 ['string', 'null'] → 'string'） */
export function resolveJsonSchemaType(t: string | string[] | undefined): string | undefined {
  if (Array.isArray(t)) {
    return t.find((x) => x !== 'null')
  }
  return t
}

/** 拼接嵌套路径 */
function subpath(path: string, key: string): string {
  return path ? `${path}.${key}` : key
}

/**
 * 校验值是否符合 JSON Schema 片段
 * 返回错误消息数组，空数组表示合法
 */
export function validateJsonSchemaValue(
  val: unknown,
  schema: Record<string, unknown>,
  path = '',
): string[] {
  const rawType = schema.type as string | string[] | undefined
  const nullable = (Array.isArray(rawType) && rawType.includes('null')) || schema.nullable === true
  const t = resolveJsonSchemaType(rawType)
  const label = path || 'parameter'

  if (nullable && val === null) return []
  // 下面是类型检查（null 已在上面处理，排除 null）
  if (val === null) return [`${label} should be ${t ?? 'value'}`]

  const errors: string[] = []

  if (t === 'integer') {
    if (typeof val !== 'number' || !Number.isInteger(val)) {
      return [`${label} should be integer`]
    }
  } else if (t === 'number') {
    if (typeof val !== 'number') {
      return [`${label} should be number`]
    }
  } else if (t === 'string') {
    if (typeof val !== 'string') {
      return [`${label} should be string`]
    }
  } else if (t === 'boolean') {
    if (typeof val !== 'boolean') {
      return [`${label} should be boolean`]
    }
  } else if (t === 'array') {
    if (!Array.isArray(val)) {
      return [`${label} should be array`]
    }
  } else if (t === 'object') {
    if (typeof val !== 'object' || val === null || Array.isArray(val)) {
      return [`${label} should be object`]
    }
  }

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
        errors.push(`missing required ${subpath(path, key)}`)
      }
    }

    for (const [key, valItem] of Object.entries(obj)) {
      if (key in props) {
        errors.push(...validateJsonSchemaValue(valItem, props[key], subpath(path, key)))
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
          ...validateJsonSchemaValue(val[i], schema.items as Record<string, unknown>, prefix.replace('{}', String(i))),
        )
      }
    }
  }

  return errors
}
