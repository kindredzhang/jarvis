import { test, expect } from 'bun:test'
import { ToolRegistry } from './registry'
import { Tool, defineParams } from './base'
import { validateJsonSchemaValue } from './schema'

// ============ Schema 校验 ============

test('validateJsonSchemaValue - type checks', () => {
  expect(validateJsonSchemaValue(42, { type: 'integer' })).toEqual([])
  expect(validateJsonSchemaValue('hi', { type: 'string' })).toEqual([])
  expect(validateJsonSchemaValue(true, { type: 'boolean' })).toEqual([])
  expect(validateJsonSchemaValue([1, 2], { type: 'array' })).toEqual([])
  expect(validateJsonSchemaValue({ a: 1 }, { type: 'object' })).toEqual([])

  expect(validateJsonSchemaValue('hi', { type: 'integer' })).toEqual(['parameter should be integer'])
  expect(validateJsonSchemaValue(4.2, { type: 'integer' })).toEqual(['parameter should be integer'])
  expect(validateJsonSchemaValue(null, { type: 'string' })).toEqual(['parameter should be string'])
})

test('validateJsonSchemaValue - nullable', () => {
  expect(validateJsonSchemaValue(null, { type: 'string', nullable: true })).toEqual([])
})

test('validateJsonSchemaValue - enum', () => {
  expect(validateJsonSchemaValue('a', { type: 'string', enum: ['a', 'b'] })).toEqual([])
  expect(validateJsonSchemaValue('c', { type: 'string', enum: ['a', 'b'] })).toEqual([
    'parameter must be one of ["a","b"]',
  ])
})

test('validateJsonSchemaValue - numeric bounds', () => {
  expect(validateJsonSchemaValue(5, { type: 'integer', minimum: 1, maximum: 10 })).toEqual([])
  expect(validateJsonSchemaValue(0, { type: 'integer', minimum: 1 })).toEqual(['parameter must be >= 1'])
  expect(validateJsonSchemaValue(11, { type: 'integer', maximum: 10 })).toEqual(['parameter must be <= 10'])
})

test('validateJsonSchemaValue - string length', () => {
  expect(validateJsonSchemaValue('hello', { type: 'string', minLength: 1, maxLength: 10 })).toEqual([])
  expect(validateJsonSchemaValue('', { type: 'string', minLength: 1 })).toEqual(['parameter must be at least 1 chars'])
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
  expect(validateJsonSchemaValue({ name: 'Alice', age: 30, tags: ['a', 'b'] }, schema)).toEqual([])
  expect(validateJsonSchemaValue({ age: 30 }, schema)).toEqual(['missing required name'])
  expect(validateJsonSchemaValue({ name: 'Bob', age: -1 }, schema)).toEqual(['age must be >= 0'])
  expect(validateJsonSchemaValue({ name: 'Bob', tags: [1, 2] }, schema)).toEqual([
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
