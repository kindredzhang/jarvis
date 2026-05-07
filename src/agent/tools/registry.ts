/**
 * ToolRegistry —— 工具注册表
 *
 * 负责工具的注册/注销/查找，提供缓存排序的工具定义列表给 LLM，
 * 以及安全的 prepareCall + execute 两步执行流程。
 */

import { Tool, type ToolDefinition } from './base'

export class ToolRegistry {
  private tools = new Map<string, Tool>()
  private cachedDefinitions: ToolDefinition[] | null = null

  /** 注册工具 */
  register(tool: Tool): void {
    this.tools.set(tool.name, tool)
    this.cachedDefinitions = null
  }

  /** 注销工具 */
  unregister(name: string): void {
    this.tools.delete(name)
    this.cachedDefinitions = null
  }

  /** 根据名称获取工具 */
  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  /** 检查工具是否已注册 */
  has(name: string): boolean {
    return this.tools.has(name)
  }

  /** 所有已注册的工具名称 */
  get toolNames(): string[] {
    return [...this.tools.keys()]
  }

  /** 注册的工具数量 */
  get size(): number {
    return this.tools.size
  }

  /**
   * 获取工具定义列表（带缓存 & 排序）
   *
   * 内置工具按名称排序作为稳定前缀，mcp_ 开头的工具放在后面。
   * 结果缓存到下一次 register/unregister 调用。
   */
  getDefinitions(): ToolDefinition[] {
    if (this.cachedDefinitions) return this.cachedDefinitions

    const builtins: ToolDefinition[] = []
    const mcpTools: ToolDefinition[] = []

    for (const tool of this.tools.values()) {
      const def = tool.toSchema()
      if (tool.name.startsWith('mcp_')) {
        mcpTools.push(def)
      } else {
        builtins.push(def)
      }
    }

    builtins.sort((a, b) => a.function.name.localeCompare(b.function.name))
    mcpTools.sort((a, b) => a.function.name.localeCompare(b.function.name))

    this.cachedDefinitions = [...builtins, ...mcpTools]
    return this.cachedDefinitions
  }

  /**
   * 解析、转换并校验工具调用
   *
   * 返回 { tool, params, error }
   * - error 不为空时表示调用不合法
   * - tool 为找到的工具实例
   * - params 为经过类型转换后的参数
   */
  prepareCall(name: string, params: Record<string, unknown>): {
    tool: Tool | undefined
    params: Record<string, unknown>
    error: string | null
  } {
    const tool = this.tools.get(name)
    if (!tool) {
      return {
        tool: undefined,
        params,
        error: `Error: Tool '${name}' not found. Available: ${this.toolNames.join(', ')}`,
      }
    }

    const castParams = tool.castParams(params)
    const errors = tool.validateParams(castParams)

    if (errors.length > 0) {
      return {
        tool,
        params: castParams,
        error: `Error: Invalid parameters for tool '${name}': ${errors.join('; ')}`,
      }
    }

    return { tool, params: castParams, error: null }
  }

  /**
   * 按名称执行工具
   *
   * 内部调用 prepareCall，出错时返回错误消息而非抛出异常。
   */
  async execute(name: string, params: Record<string, unknown>): Promise<unknown> {
    const HINT = '\n\n[Analyze the error above and try a different approach.]'
    const { tool, params: castParams, error } = this.prepareCall(name, params)

    if (error) {
      return error + HINT
    }

    try {
      const result = await tool!.execute(castParams)
      if (typeof result === 'string' && result.startsWith('Error')) {
        return result + HINT
      }
      return result
    } catch (err) {
      return `Error executing ${name}: ${err instanceof Error ? err.message : String(err)}` + HINT
    }
  }
}
