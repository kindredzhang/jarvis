/**
 * MCP 集成 —— Model Context Protocol 客户端
 *
 * 支持三种传输方式：
 * - stdio：启动本地进程（npx / bunx 等）
 * - streamableHttp：HTTP POST + SSE 响应（远程服务器，推荐）
 * - websocket：WebSocket 连接（远程服务器）
 *
 * 将 MCP 服务器的 tools 包装为 Tool 注册到 ToolRegistry。
 *
 * ========= TODO: 与 nanobot 差异标注 =========
 * - 无 MCPResourceWrapper（resource 包装）
 * - 无 MCPPromptWrapper（prompt 包装）
 * - 无 schema 规范化（nullable oneOf/anyOf）
 * - 无重试逻辑
 */

import { Tool } from './base'
import type { ToolRegistry } from './registry'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js'
import type { Tool as MCPTool } from '@modelcontextprotocol/sdk/types.js'

// ---- 配置类型 ----

export interface MCPServerConfig {
  /** 服务器名称（用于工具命名前缀 mcp_{name}_tool） */
  name: string
  /** 传输类型 */
  type: 'stdio' | 'streamableHttp' | 'websocket'
  /** stdio: 可执行命令（如 npx, bunx, python） */
  command?: string
  /** stdio: 命令参数 */
  args?: string[]
  /** stdio: 环境变量 */
  env?: Record<string, string>
  /** streamableHttp / websocket: 服务器 URL */
  url?: string
  /** 工具调用超时（秒，默认 30） */
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
    const schema = (toolDef as any).inputSchema ?? { type: 'object', properties: {} }
    this.parameters = {
      type: 'object',
      properties: (typeof schema.properties === 'object' ? schema.properties : {}),
      ...(Array.isArray(schema.required) ? { required: schema.required } : {}),
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
      const content = result.content as { type: string; text?: string }[] | undefined
      if (!content || content.length === 0) return '(no output)'
      return content
        .map((b) => (b.type === 'text' ? b.text ?? '' : JSON.stringify(b)))
        .filter(Boolean)
        .join('\n')
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        return `(MCP tool call timed out after ${this.timeout}s)`
      }
      return `(MCP tool call failed: ${err instanceof Error ? err.message : String(err)})`
    }
  }
}

// ---- 连接管理 ----

const activeConnections = new Map<string, { client: Client; cleanup: () => Promise<void> }>()

/**
 * 连接到 MCP 服务器并注册其工具
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

  const client = new Client(
    { name: 'jarvis-mcp', version: '1.0.0' },
    { capabilities: {} },
  )

  console.log(`[MCP] Connecting to '${config.name}' (${config.type})...`)

  switch (config.type) {
    case 'stdio': {
      if (!config.command) throw new Error(`MCP '${config.name}': command required for stdio`)
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: config.env,
      })
      await client.connect(transport)
      break
    }
    case 'streamableHttp': {
      if (!config.url) throw new Error(`MCP '${config.name}': url required for streamableHttp`)
      const transport = new StreamableHTTPClientTransport(new URL(config.url))
      await client.connect(transport)
      break
    }
    case 'websocket': {
      if (!config.url) throw new Error(`MCP '${config.name}': url required for websocket`)
      const transport = new WebSocketClientTransport(new URL(config.url))
      await client.connect(transport)
      break
    }
    default:
      throw new Error(`MCP '${config.name}': unknown transport '${config.type}'`)
  }

  // 获取并注册工具
  const toolsResult = await client.listTools()
  const tools = toolsResult.tools ?? []
  const timeout = config.toolTimeout ?? 30

  for (const toolDef of tools) {
    const wrapper = new MCPToolWrapper(client, config.name, toolDef, timeout)
    registry.register(wrapper)
    console.log(`[MCP] Registered tool: ${wrapper.name}`)
  }

  console.log(`[MCP] Server '${config.name}' connected: ${tools.length} tool(s)`)

  const cleanup = async () => {
    await client.close()
    activeConnections.delete(config.name)
    console.log(`[MCP] Server '${config.name}' disconnected`)
  }
  activeConnections.set(config.name, { client, cleanup })
  return cleanup
}

/** 批量连接多个 MCP 服务器 */
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
      console.error(`[MCP] Failed '${config.name}': ${err instanceof Error ? err.message : err}`)
    }
  }
  return cleanups
}
