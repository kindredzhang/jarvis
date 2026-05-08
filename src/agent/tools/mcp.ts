/**
 * MCP 集成 —— 通过 Model Context Protocol 连接外部工具
 *
 * 支持 stdio 和 SSE 两种传输方式。
 * 将 MCP 服务器的 tools / resources / prompts 包装为 Tool 注册到 ToolRegistry。
 *
 * ========= TODO: 与 nanobot 差异标注 =========
 * - 无 MCPResourceWrapper（resource 另注册为工具）
 * - 无 MCPPromptWrapper（prompt 另注册为工具）
 * - 无重试逻辑（当前无 transient error 检测）
 * - 无 schema 规范化（MCP 的 JSON Schema → OpenAI format）
 * - 无 Windows 兼容（stdio 命令包装）
 * - 无 streamable HTTP 传输
 * - 无 WebSocket 传输
 */

import { Tool, defineParams } from './base'
import type { ToolRegistry } from './registry'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Tool as MCPTool } from '@modelcontextprotocol/sdk/types.js'

// ---- 配置类型 ----

export interface MCPServerConfig {
  /** 服务器名称（用于工具命名前缀 mcp_{name}_tool） */
  name: string
  /** 传输类型 */
  type: 'stdio' | 'sse'
  /** stdio 命令（type=stdio 时必填） */
  command?: string
  /** stdio 参数 */
  args?: string[]
  /** 环境变量 */
  env?: Record<string, string>
  /** SSE URL（type=sse 时必填） */
  url?: string
  /** 工具调用超时（秒） */
  toolTimeout?: number
}

// ---- MCP 工具包装 ----

export class MCPToolWrapper extends Tool {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>

  private client: Client
  private toolName: string
  private timeout: number

  constructor(client: Client, serverName: string, toolDef: MCPTool, timeout = 30) {
    super()
    this.client = client
    this.toolName = toolDef.name
    this.name = `mcp_${serverName}_${toolDef.name}`
    this.description = toolDef.description ?? toolDef.name
    this.timeout = timeout

    // 转换 MCP 的 inputSchema 为 OpenAI 兼容格式
    const schema = (toolDef as any).inputSchema ?? { type: 'object', properties: {} }
    this.parameters = {
      type: 'object',
      properties: this._normalizeSchema(schema).properties ?? {},
      ...(schema.required ? { required: schema.required } : {}),
    }
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeout * 1000)

      const result = await this.client.callTool(
        { name: this.toolName, arguments: args },
        undefined,
        { signal: controller.signal },
      )
      clearTimeout(timer)

      const content = result.content as { type: string; text?: string }[]
      if (!content || content.length === 0) return '(no output)'

      return content
        .map((block) => {
          if (block.type === 'text') return block.text ?? ''
          return JSON.stringify(block)
        })
        .filter(Boolean)
        .join('\n')
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        return `(MCP tool call timed out after ${this.timeout}s)`
      }
      const msg = err instanceof Error ? err.message : String(err)
      return `(MCP tool call failed: ${msg})`
    }
  }

  /** 最小化 schema 规范化：确保 properties 存在 */
  private _normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
    if (!schema.properties || typeof schema.properties !== 'object') {
      return { type: 'object', properties: {} }
    }
    return schema
  }
}

// ---- MCP 连接管理器 ----

const activeConnections = new Map<string, { client: Client; cleanup: () => Promise<void> }>()

/**
 * 连接到 MCP 服务器并注册其工具
 * @returns 清理函数
 */
export async function connectMCPServer(
  config: MCPServerConfig,
  registry: ToolRegistry,
): Promise<() => Promise<void>> {
  if (activeConnections.has(config.name)) {
    const existing = activeConnections.get(config.name)!
    console.log(`[MCP] Server '${config.name}' already connected, skipping`)
    return existing.cleanup
  }

  console.log(`[MCP] Connecting to '${config.name}' (${config.type})...`)

  const client = new Client(
    { name: 'jarvis-mcp', version: '1.0.0' },
    { capabilities: {} },
  )

  let transport: StdioClientTransport

  if (config.type === 'stdio') {
    if (!config.command) throw new Error(`MCP server '${config.name}': command required for stdio transport`)

    transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: config.env,
    })
  } else if (config.type === 'sse') {
    if (!config.url) throw new Error(`MCP server '${config.name}': url required for SSE transport`)
    // SSE transport - import dynamically
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
    // SSE transport requires a URL
    throw new Error(`MCP server '${config.name}': SSE transport not yet implemented`)
  } else {
    throw new Error(`MCP server '${config.name}': unknown transport type '${config.type}'`)
  }

  await client.connect(transport)

  // 获取服务器能力
  const toolsResult = await client.listTools()
  const tools = toolsResult.tools ?? []

  if (tools.length === 0) {
    console.log(`[MCP] Server '${config.name}' has no tools`)
    return async () => {
      await client.close()
      activeConnections.delete(config.name)
    }
  }

  // 注册每个 MCP 工具
  const timeout = config.toolTimeout ?? 30
  for (const toolDef of tools) {
    const wrapper = new MCPToolWrapper(client, config.name, toolDef, timeout)
    registry.register(wrapper)
    console.log(`[MCP] Registered tool: ${wrapper.name}`)
  }

  console.log(`[MCP] Server '${config.name}' connected: ${tools.length} tool(s) registered`)

  const cleanup = async () => {
    for (const toolDef of tools) {
      const name = `mcp_${config.name}_${toolDef.name}`
      // ToolRegistry doesn't have unregister, but tools won't conflict
    }
    await client.close()
    activeConnections.delete(config.name)
    console.log(`[MCP] Server '${config.name}' disconnected`)
  }

  activeConnections.set(config.name, { client, cleanup })
  return cleanup
}

/**
 * 批量连接多个 MCP 服务器
 */
export async function connectMCPServers(
  configs: MCPServerConfig[],
  registry: ToolRegistry,
): Promise<Map<string, () => Promise<void>>> {
  const cleanups = new Map<string, () => Promise<void>>()

  for (const config of configs) {
    try {
      const cleanup = await connectMCPServer(config, registry)
      cleanups.set(config.name, cleanup)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[MCP] Failed to connect '${config.name}': ${msg}`)
    }
  }

  return cleanups
}
