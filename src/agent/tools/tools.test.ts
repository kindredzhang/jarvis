import { test, expect } from 'bun:test'
import { ToolRegistry } from './registry'
import { Tool, defineParams } from './base'
import { Schema, StringSchema, IntegerSchema, NumberSchema, BooleanSchema, ArraySchema, ObjectSchema, toolParametersSchema } from './schema'

// ============ Schema 校验 ============

test('validateJsonSchemaValue - type checks', () => {
  expect(Schema.validateJsonSchemaValue(42, { type: 'integer' })).toEqual([])
  expect(Schema.validateJsonSchemaValue('hi', { type: 'string' })).toEqual([])
  expect(Schema.validateJsonSchemaValue(true, { type: 'boolean' })).toEqual([])
  expect(Schema.validateJsonSchemaValue([1, 2], { type: 'array' })).toEqual([])
  expect(Schema.validateJsonSchemaValue({ a: 1 }, { type: 'object' })).toEqual([])

  expect(Schema.validateJsonSchemaValue('hi', { type: 'integer' })).toEqual(['parameter should be integer'])
  expect(Schema.validateJsonSchemaValue(4.2, { type: 'integer' })).toEqual(['parameter should be integer'])
  expect(Schema.validateJsonSchemaValue(null, { type: 'string' })).toEqual(['parameter should be string'])
})

test('validateJsonSchemaValue - nullable', () => {
  expect(Schema.validateJsonSchemaValue(null, { type: 'string', nullable: true })).toEqual([])
})

test('validateJsonSchemaValue - enum', () => {
  expect(Schema.validateJsonSchemaValue('a', { type: 'string', enum: ['a', 'b'] })).toEqual([])
  expect(Schema.validateJsonSchemaValue('c', { type: 'string', enum: ['a', 'b'] })).toEqual([
    'parameter must be one of ["a","b"]',
  ])
})

test('validateJsonSchemaValue - numeric bounds', () => {
  expect(Schema.validateJsonSchemaValue(5, { type: 'integer', minimum: 1, maximum: 10 })).toEqual([])
  expect(Schema.validateJsonSchemaValue(0, { type: 'integer', minimum: 1 })).toEqual(['parameter must be >= 1'])
  expect(Schema.validateJsonSchemaValue(11, { type: 'integer', maximum: 10 })).toEqual(['parameter must be <= 10'])
})

test('validateJsonSchemaValue - string length', () => {
  expect(Schema.validateJsonSchemaValue('hello', { type: 'string', minLength: 1, maxLength: 10 })).toEqual([])
  expect(Schema.validateJsonSchemaValue('', { type: 'string', minLength: 1 })).toEqual(['parameter must be at least 1 chars'])
})

test('validateJsonSchemaValue - nested object', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      age: { type: 'integer', minimum: 0 },
      tags: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: ['name'],
  }
  expect(Schema.validateJsonSchemaValue({ name: 'Alice', age: 30, tags: ['a', 'b'] }, schema)).toEqual([])
  expect(Schema.validateJsonSchemaValue({ age: 30 }, schema)).toEqual(['missing required name'])
  expect(Schema.validateJsonSchemaValue({ name: 'Bob', age: -1 }, schema)).toEqual(['age must be >= 0'])
  expect(Schema.validateJsonSchemaValue({ name: 'Bob', tags: [1, 2] }, schema)).toEqual([
    'tags[0] should be string',
    'tags[1] should be string',
  ])
})

// ============ Tool 抽象类 ============

class GreetTool extends Tool {
  readonly name = 'greet'
  readonly description = '向用户打招呼'
  readonly parameters = defineParams({
    type: 'object',
    properties: {
      name: { type: 'string', description: '用户名' },
      count: { type: 'integer', description: '次数', minimum: 1 },
    },
    required: ['name'],
  })
  get readOnly(): boolean {
    return true
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const name = args.name as string
    const count = (args.count as number) ?? 1
    return Array.from({ length: count }, () => `Hello ${name}!`).join('\n')
  }
}

test('Tool - castParams string to integer', () => {
  const tool = new GreetTool()
  const cast = tool.castParams({ name: 'Alice', count: '3' })
  expect(cast.count).toBe(3)
  expect(typeof cast.count).toBe('number')
})

test('Tool - castParams string to integer (invalid)', () => {
  const tool = new GreetTool()
  const cast = tool.castParams({ name: 'Alice', count: 'abc' })
  expect(cast.count).toBe('abc')
  expect(typeof cast.count).toBe('string')
})

test('Tool - validateParams', () => {
  const tool = new GreetTool()
  expect(tool.validateParams({ name: 'Alice', count: 3 })).toEqual([])
  expect(tool.validateParams({ count: 3 })).toContain('missing required name')
  expect(tool.validateParams({ name: 'Alice', count: 0 })).toContain('count must be >= 1')
})

test('Tool - toSchema', () => {
  const tool = new GreetTool()
  const schema = tool.toSchema()
  expect(schema.type).toBe('function')
  expect(schema.function.name).toBe('greet')
  expect(schema.function.parameters).toBeDefined()
})

test('Tool - readOnly / concurrencySafe / exclusive', () => {
  const tool = new GreetTool()
  expect(tool.readOnly).toBe(true)
  expect(tool.concurrencySafe).toBe(true)
  expect(tool.exclusive).toBe(false)
})

// ============ ToolRegistry ============

test('ToolRegistry - register and get', () => {
  const registry = new ToolRegistry()
  const tool = new GreetTool()
  registry.register(tool)
  expect(registry.get('greet')).toBe(tool)
  expect(registry.has('greet')).toBe(true)
  expect(registry.has('nonexistent')).toBe(false)
})

test('ToolRegistry - unregister', () => {
  const registry = new ToolRegistry()
  registry.register(new GreetTool())
  registry.unregister('greet')
  expect(registry.has('greet')).toBe(false)
})

test('ToolRegistry - toolNames', () => {
  const registry = new ToolRegistry()
  registry.register(new GreetTool())
  expect(registry.toolNames).toEqual(['greet'])
})

test('ToolRegistry - getDefinitions with caching', () => {
  const registry = new ToolRegistry()
  registry.register(new GreetTool())
  const defs = registry.getDefinitions()
  expect(defs).toHaveLength(1)
  expect(defs[0].function.name).toBe('greet')

  // 第二次调用走缓存
  const defs2 = registry.getDefinitions()
  expect(defs2).toBe(defs)
})

test('ToolRegistry - getDefinitions sorts mcp tools last', () => {
  const registry = new ToolRegistry()

  class McpFileTool extends Tool {
    readonly name = 'mcp_read_file'
    readonly description = 'MCP file read'
    readonly parameters = defineParams({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] })
    async execute(args: Record<string, unknown>): Promise<string> { return 'ok' }
  }

  registry.register(new GreetTool())
  registry.register(new McpFileTool())

  const defs = registry.getDefinitions()
  expect(defs[0].function.name).toBe('greet')
  expect(defs[1].function.name).toBe('mcp_read_file')
})

test('ToolRegistry - prepareCall success', () => {
  const registry = new ToolRegistry()
  registry.register(new GreetTool())

  const { tool, params, error } = registry.prepareCall('greet', { name: 'Alice', count: '2' })
  expect(tool).toBeDefined()
  expect(params.name).toBe('Alice')
  expect(params.count).toBe(2) // 已转换
  expect(error).toBeNull()
})

test('ToolRegistry - prepareCall tool not found', () => {
  const registry = new ToolRegistry()
  const { tool, error } = registry.prepareCall('nope', {})
  expect(tool).toBeUndefined()
  expect(error).toContain("Tool 'nope' not found")
})

test('ToolRegistry - prepareCall invalid params', () => {
  const registry = new ToolRegistry()
  registry.register(new GreetTool())

  const { error } = registry.prepareCall('greet', {})
  expect(error).toContain("Invalid parameters for tool 'greet'")
})

test('ToolRegistry - execute success', async () => {
  const registry = new ToolRegistry()
  registry.register(new GreetTool())

  const result = await registry.execute('greet', { name: 'Alice', count: 2 })
  expect(result).toBe('Hello Alice!\nHello Alice!')
})

test('ToolRegistry - execute tool not found', async () => {
  const registry = new ToolRegistry()
  const result = await registry.execute('nope', {})
  expect(result).toContain("Tool 'nope' not found")
})

test('ToolRegistry - execute error in tool', async () => {
  const registry = new ToolRegistry()

  class BrokenTool extends Tool {
    readonly name = 'broken'
    readonly description = 'always fails'
    readonly parameters = defineParams({ type: 'object', properties: {} })
    async execute(args: Record<string, unknown>): Promise<never> {
      throw new Error('something went wrong')
    }
  }
  registry.register(new BrokenTool())

  const result = await registry.execute('broken', {})
  expect(result).toContain('Error executing broken')
  expect(result).toContain('something went wrong')
})

// ============ Schema 子类 ============

test('StringSchema - toJsonSchema', () => {
  const s = new StringSchema({ description: '名称', minLength: 1, maxLength: 50 })
  const schema = s.toJsonSchema()
  expect(schema.type).toBe('string')
  expect(schema.description).toBe('名称')
  expect(schema.minLength).toBe(1)
  expect(schema.maxLength).toBe(50)
})

test('StringSchema - nullable', () => {
  const s = new StringSchema({ description: '备注', nullable: true })
  const schema = s.toJsonSchema()
  expect(schema.type).toEqual(['string', 'null'])
})

test('StringSchema - enum', () => {
  const s = new StringSchema({ description: '颜色', enum: ['red', 'green', 'blue'] })
  const schema = s.toJsonSchema()
  expect(schema.enum).toEqual(['red', 'green', 'blue'])
})

test('StringSchema - validateValue', () => {
  const s = new StringSchema({ minLength: 2, maxLength: 5 })
  expect(s.validateValue('ab')).toEqual([])
  expect(s.validateValue('a')).toEqual(['parameter must be at least 2 chars'])
  expect(s.validateValue('abcdef')).toEqual(['parameter must be at most 5 chars'])
})

test('IntegerSchema - toJsonSchema', () => {
  const s = new IntegerSchema({ description: '年龄', minimum: 0, maximum: 150 })
  const schema = s.toJsonSchema()
  expect(schema.type).toBe('integer')
  expect(schema.minimum).toBe(0)
  expect(schema.maximum).toBe(150)
})

test('IntegerSchema - validateValue', () => {
  const s = new IntegerSchema({ minimum: 0 })
  expect(s.validateValue(5)).toEqual([])
  expect(s.validateValue(-1)).toEqual(['parameter must be >= 0'])
  expect(s.validateValue(3.14)).toEqual(['parameter should be integer'])
})

test('NumberSchema - toJsonSchema', () => {
  const s = new NumberSchema({ description: '价格', minimum: 0 })
  expect(s.toJsonSchema().type).toBe('number')
  expect(s.toJsonSchema().minimum).toBe(0)
})

test('BooleanSchema - toJsonSchema', () => {
  const s = new BooleanSchema({ description: '是否启用', default: false })
  const schema = s.toJsonSchema()
  expect(schema.type).toBe('boolean')
  expect(schema.default).toBe(false)
})

test('ArraySchema - toJsonSchema with StringSchema items', () => {
  const s = new ArraySchema({ items: new StringSchema({ description: '标签' }), minItems: 1 })
  const schema = s.toJsonSchema()
  expect(schema.type).toBe('array')
  expect((schema as any).items.type).toBe('string')
  expect(schema.minItems).toBe(1)
})

test('ObjectSchema - toJsonSchema', () => {
  const s = new ObjectSchema({
    properties: {
      name: new StringSchema({ description: '名称' }),
      age: new IntegerSchema({ description: '年龄', minimum: 0 }),
    },
    required: ['name'],
    description: '用户信息',
  })
  const schema = s.toJsonSchema()
  expect(schema.type).toBe('object')
  expect(schema.description).toBe('用户信息')
  expect((schema as any).properties.name.type).toBe('string')
  expect((schema as any).properties.age.type).toBe('integer')
  expect(schema.required).toEqual(['name'])
})

test('ObjectSchema - validateValue', () => {
  const s = new ObjectSchema({
    properties: {
      name: new StringSchema({ minLength: 1 }),
      count: new IntegerSchema({ minimum: 0 }),
    },
    required: ['name'],
  })
  expect(s.validateValue({ name: 'Alice', count: 5 })).toEqual([])
  expect(s.validateValue({})).toEqual(['missing required name'])
  expect(s.validateValue({ name: 'Alice', count: -1 })).toEqual(['count must be >= 0'])
})

test('toolParametersSchema - builds root parameter schema', () => {
  const schema = toolParametersSchema({
    required: ['path'],
    description: '读取文件内容',
    properties: {
      path: new StringSchema({ description: '文件路径' }),
      encoding: new StringSchema({ description: '编码', enum: ['utf-8', 'gbk'] }),
    },
  })
  expect(schema.type).toBe('object')
  expect(schema.required).toEqual(['path'])
  expect(schema.description).toBe('读取文件内容')
  expect((schema as any).properties.path.type).toBe('string')
  expect((schema as any).properties.encoding.enum).toEqual(['utf-8', 'gbk'])
})
