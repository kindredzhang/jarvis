/**
 * MyTool —— runtime state inspection and configuration
 *
 * 1:1 port of nanobot/agent/tools/self.py (450 lines).
 */

import { Tool, defineParams } from './base'
import type { AgentLoop } from '../loop'
import type { SubagentStatus } from '../subagent'

// ---- Security constants ----

const BLOCKED = new Set([
  'bus', 'provider', '_running', 'tools',
  '_runtime_vars',
  'runner', 'sessions', 'consolidator',
  'dream', 'autoCompact', 'context', 'commands',
  '_mcp_servers', '_mcp_stacks', '_pending_queues',
  '_session_locks', '_active_tasks', '_background_tasks',
  'restrict_to_workspace', 'channels_config',
  '_concurrency_gate', '_unified_session', '_extra_hooks',
])

const READ_ONLY = new Set([
  'subagents',
  '_current_iteration',
  'execConfig',
  'webConfig',
])

const _DENIED_ATTRS = new Set([
  '__class__', '__dict__', '__bases__', '__subclasses__', '__mro__',
  '__init__', '__new__', '__reduce__', '__getstate__', '__setstate__',
  '__del__', '__call__', '__getattr__', '__setattr__', '__delattr__',
  '__code__', '__globals__', 'func_globals', 'func_code',
  '__wrapped__', '__closure__',
  'constructor', 'prototype',
])

const _SENSITIVE_NAMES = new Set([
  'api_key', 'secret', 'password', 'token', 'credential',
  'private_key', 'access_token', 'refresh_token', 'auth',
])

function isSensitiveFieldName(name: string): boolean {
  const lowered = name.toLowerCase()
  if (_SENSITIVE_NAMES.has(lowered)) return true
  return lowered.split('_').some((part) => _SENSITIVE_NAMES.has(part))
}

interface RestrictedSpec {
  type: 'int' | 'string'
  min?: number
  max?: number
  min_len?: number
}

const RESTRICTED: Record<string, RestrictedSpec> = {
  maxIterations:       { type: 'int', min: 1,   max: 100 },
  contextWindowTokens: { type: 'int', min: 4096, max: 1_000_000 },
  model:               { type: 'string', min_len: 1 },
}

const MAX_RUNTIME_KEYS = 64

// ---- Helpers ----

function hasRealAttr(obj: unknown, key: string): boolean {
  if (obj === null || obj === undefined) return false
  if (typeof obj === 'object' && !Array.isArray(obj)) {
    if (key in obj) {
      const desc = Object.getOwnPropertyDescriptor(obj, key)
      if (desc) return true
      // Check prototype chain
      let proto = Object.getPrototypeOf(obj)
      while (proto && proto !== Object.prototype) {
        if (Object.prototype.hasOwnProperty.call(proto, key)) return true
        proto = Object.getPrototypeOf(proto)
      }
      return false
    }
    return false
  }
  return false
}

// ---- MyTool ----

export class MyTool extends Tool {
  readonly name = 'my'
  readonly parameters = defineParams({
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['check', 'set'],
        description: 'Action to perform',
      },
      key: {
        type: 'string',
        description:
          "Dot-path for check/set. Examples: 'maxIterations', 'workspace', 'providerRetryMode'. " +
          'For check without key, shows all config values.',
      },
      value: {
        description:
          'New value (for set). Type must match target (int for maxIterations/contextWindowTokens, str for model).',
      },
    },
    required: ['action'],
  })

  private _loop: AgentLoop
  private _modifyAllowed: boolean
  private _channel = ''
  private _chatId = ''

  constructor(loop: AgentLoop, modifyAllowed = true) {
    super()
    this._loop = loop
    this._modifyAllowed = modifyAllowed
  }

  get description(): string {
    let base =
      'Check and set your own runtime state.\n' +
      'Actions: check, set.\n' +
      '- check (no key): full config overview — start here.\n' +
      '- check (key): drill into a value. Dot-paths allowed ' +
      "(e.g. '_lastUsage.promptTokens', 'webConfig.enable').\n" +
      '- set (key, value): change config or store notes in your scratchpad. ' +
      'Scratchpad keys persist across turns but not restarts.\n' +
      'Key values: _current_iteration (current progress), ' +
      'maxIterations - _current_iteration = remaining iterations.\n' +
      'Note: webConfig and execConfig are readable but read-only.\n' +
      '\n' +
      'When to use:\n' +
      '- User asks about your model, settings, or token usage → check that key.\n' +
      '- A tool fails or behaves unexpectedly → check the related config to diagnose.\n' +
      '- User asks you to remember a preference for this session → set to store it in your scratchpad.\n' +
      '- About to start a large task → check contextWindowTokens and maxIterations first.'
    if (!this._modifyAllowed) {
      base += '\nREAD-ONLY MODE: set is disabled.'
    } else {
      base +=
        '\nIMPORTANT: Before setting state, predict the potential impact. ' +
        'If the operation could cause crashes or instability ' +
        '(e.g. changing model), warn the user first.'
    }
    return base
  }

  setContext(channel: string, chatId: string): void {
    this._channel = channel
    this._chatId = chatId
  }

  // ---- Action dispatch ----

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = (args.action as string) ?? ''
    const key = (args.key as string) ?? null
    const value = args.value

    if (action === 'check' || action === 'inspect') {
      return this._inspect(key)
    }
    if (!this._modifyAllowed) {
      return 'Error: set is disabled (tools.my.allow_set is false)'
    }
    if (action === 'set' || action === 'modify') {
      return this._modify(key, value)
    }
    return `Unknown action: ${action}`
  }

  // ---- Audit ----

  private _audit(action: string, detail: string): void {
    const session = this._channel ? `${this._channel}:${this._chatId}` : 'unknown'
    console.info(`self.${action} | ${detail} | session:${session}`)
  }

  // ---- Path resolution ----

  private _resolvePath(path: string): { value: unknown; error: string | null } {
    const parts = path.split('.')
    let obj: unknown = this._loop as unknown as Record<string, unknown>
    for (const part of parts) {
      if (_DENIED_ATTRS.has(part) || part.startsWith('__')) {
        return { value: null, error: `'${part}' is not accessible` }
      }
      if (BLOCKED.has(part)) {
        return { value: null, error: `'${part}' is not accessible` }
      }
      if (isSensitiveFieldName(part)) {
        return { value: null, error: `'${part}' is not accessible` }
      }
      try {
        if (obj && typeof obj === 'object') {
          if (part in (obj as Record<string, unknown>)) {
            obj = (obj as Record<string, unknown>)[part]
          } else {
            return { value: null, error: `'${part}' not found in object` }
          }
        } else {
          return { value: null, error: `'${part}' not found: cannot traverse ${typeof obj}` }
        }
      } catch (e) {
        return { value: null, error: `'${part}' not found: ${e}` }
      }
    }
    return { value: obj, error: null }
  }

  private static _validateKey(key: string | null, label = 'key'): string | null {
    if (!key || !key.trim()) {
      return `Error: '${label}' cannot be empty or whitespace`
    }
    return null
  }

  // ---- Smart formatting ----

  private static _formatStatus(st: SubagentStatus, indent = '  '): string {
    const elapsed = (Date.now() - st.startedAt) / 1000
    const toolSummary =
      st.toolEvents.slice(-5).map((e) => `${e.name}(${e.status})`).join(', ') || 'none'
    const lines = [
      `${indent}phase: ${st.phase}, iteration: ${st.iteration}, elapsed: ${elapsed.toFixed(1)}s`,
      `${indent}tools: ${toolSummary}`,
      `${indent}usage: ${Object.keys(st.usage).length ? JSON.stringify(st.usage) : 'n/a'}`,
    ]
    if (st.error) lines.push(`${indent}error: ${st.error}`)
    if (st.stopReason) lines.push(`${indent}stop_reason: ${st.stopReason}`)
    return lines.join('\n')
  }

  private static _formatValue(val: unknown, key = ''): string {
    // SubagentStatus
    if (typeof val === 'object' && val !== null && 'taskId' in val && 'label' in val && 'startedAt' in val) {
      const st = val as SubagentStatus
      const header = `Subagent [${st.taskId}] '${st.label}'`
      const detail = MyTool._formatStatus(st, '  ')
      return `${header}\n  task: ${st.taskDescription}\n${detail}`
    }
    // SubagentManager: delegate to its _taskStatuses map (Map<string, SubagentStatus>)
    if (typeof val === 'object' && val !== null && '_taskStatuses' in val) {
      const taskStatuses = (val as { _taskStatuses: Map<string, SubagentStatus> })._taskStatuses
      if (taskStatuses instanceof Map) {
        return MyTool._formatValue(taskStatuses, key)
      }
    }
    // Map of SubagentStatus values
    if (val instanceof Map && val.size > 0) {
      const firstVal = val.values().next().value
      if (firstVal && typeof firstVal === 'object' && 'taskId' in firstVal) {
        const prefix = key ? `${key}: ` : ''
        const lines = [`${prefix}${val.size} subagent(s):`]
        for (const [tid, st] of val) {
          const detail = MyTool._formatStatus(st as SubagentStatus, '    ')
          lines.push(`  [${tid}] '${(st as SubagentStatus).label}'\n${detail}`)
        }
        return lines.join('\n')
      }
    }
    // ToolRegistry: check for tool_names equivalent
    if (typeof val === 'object' && val !== null && 'toolNames' in val) {
      const toolNames = (val as { toolNames: string[] }).toolNames
      return `tools: ${toolNames.length} registered — ${JSON.stringify(toolNames)}`
    }
    // Scalar types
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean' || val === null || val === undefined) {
      const r = JSON.stringify(val)
      return key ? `${key}: ${r}` : r
    }
    // Dict / plain object
    if (typeof val === 'object' && val !== null && !Array.isArray(val) && !(val instanceof Map)) {
      const ks = Object.keys(val as Record<string, unknown>)
      if (ks.length === 0) {
        return key ? `${key}: {}` : '{}'
      }
      if (ks.length <= 5) {
        const r = JSON.stringify(val)
        if (r.length <= 200) {
          return key ? `${key}: ${r}` : r
        }
      }
      const preview = ks.slice(0, 15).join(', ')
      const suffix = ks.length > 15 ? ', ...' : ''
      return key ? `${key}: {${preview}${suffix}}` : `{${preview}${suffix}}`
    }
    // Array
    if (Array.isArray(val)) {
      if (val.length > 20) {
        return key ? `${key}: [${val.length} items]` : `[${val.length} items]`
      }
      const r = JSON.stringify(val)
      return key ? `${key}: ${r}` : r
    }
    // Complex object — try to show fields
    if (typeof val === 'object' && val !== null) {
      const clsName = (val as object).constructor.name
      const ownKeys = Object.keys(val as Record<string, unknown>).filter((k) => !isSensitiveFieldName(k))
      if (ownKeys.length > 0) {
        const preview = ownKeys.slice(0, 20).join(', ')
        const suffix = ownKeys.length > 20 ? ', ...' : ''
        return key
          ? `${key}: <${clsName}> [${preview}${suffix}]`
          : `<${clsName}> [${preview}${suffix}]`
      }
      const r = JSON.stringify(val)
      return key ? `${key}: ${r}` : r
    }
    const r = JSON.stringify(val)
    return key ? `${key}: ${r}` : r
  }

  // ---- Inspect ----

  private _inspect(key: string | null): string {
    if (!key) {
      return this._inspectAll()
    }
    const top = key.split('.')[0]!
    if (_DENIED_ATTRS.has(top) || top.startsWith('__')) {
      return `Error: '${top}' is not accessible`
    }
    const { value: obj, error: err } = this._resolvePath(key)
    if (err) {
      // "scratchpad" alias for _runtime_vars
      if (key === 'scratchpad') {
        const rv = this._loop._runtime_vars
        return rv && Object.keys(rv).length
          ? MyTool._formatValue(rv, 'scratchpad')
          : 'scratchpad is empty'
      }
      // Fallback: check _runtime_vars for simple keys
      if (!key.includes('.') && key in this._loop._runtime_vars) {
        return MyTool._formatValue(this._loop._runtime_vars[key], key)
      }
      return `Error: ${err}`
    }
    // Guard against non-existent top-level attrs
    if (!key.includes('.') && !hasRealAttr(this._loop, key)) {
      if (key in this._loop._runtime_vars) {
        return MyTool._formatValue(this._loop._runtime_vars[key], key)
      }
      return `Error: '${key}' not found`
    }
    return MyTool._formatValue(obj ?? null, key)
  }

  private _inspectAll(): string {
    const loop = this._loop
    const parts: string[] = []
    // RESTRICTED keys
    for (const k of Object.keys(RESTRICTED)) {
      const v = (loop as unknown as Record<string, unknown>)[k]
      parts.push(MyTool._formatValue(v, k))
    }
    // Other useful top-level keys
    for (const k of ['workspace', 'providerRetryMode', 'maxToolResultChars', '_current_iteration', 'webConfig', 'execConfig', 'subagents']) {
      if (hasRealAttr(loop, k)) {
        const v = (loop as unknown as Record<string, unknown>)[k]
        parts.push(MyTool._formatValue(v, k))
      }
    }
    // Token usage
    const usage = loop._lastUsage
    if (usage && Object.keys(usage).length) {
      parts.push(MyTool._formatValue(usage, '_lastUsage'))
    }
    // Scratchpad
    const rv = loop._runtime_vars
    if (rv && Object.keys(rv).length) {
      parts.push(MyTool._formatValue(rv, 'scratchpad'))
    }
    return parts.join('\n')
  }

  // ---- Modify ----

  private _modify(key: string | null, value: unknown): string {
    const keyErr = MyTool._validateKey(key)
    if (keyErr) return keyErr
    const resolvedKey = key!
    const top = resolvedKey.split('.')[0]!
    if (
      BLOCKED.has(top) ||
      _DENIED_ATTRS.has(top) ||
      top.startsWith('__') ||
      isSensitiveFieldName(top)
    ) {
      this._audit('modify', `BLOCKED ${resolvedKey}`)
      return `Error: '${resolvedKey}' is protected and cannot be modified`
    }
    if (READ_ONLY.has(top)) {
      this._audit('modify', `READ_ONLY ${resolvedKey}`)
      return `Error: '${resolvedKey}' is read-only and cannot be modified`
    }
    // Dot-path: resolve parent, set leaf
    if (resolvedKey.includes('.')) {
      const lastDot = resolvedKey.lastIndexOf('.')
      const parentPath = resolvedKey.slice(0, lastDot)
      const leaf = resolvedKey.slice(lastDot + 1)
      if (_DENIED_ATTRS.has(leaf) || leaf.startsWith('__')) {
        this._audit('modify', `BLOCKED leaf '${leaf}'`)
        return `Error: '${leaf}' is not accessible`
      }
      if (isSensitiveFieldName(leaf)) {
        this._audit('modify', `BLOCKED sensitive leaf '${leaf}'`)
        return `Error: '${leaf}' is not accessible`
      }
      const { value: parent, error: parentErr } = this._resolvePath(parentPath)
      if (parentErr) return `Error: ${parentErr}`
      if (parent && typeof parent === 'object' && !Array.isArray(parent)) {
        ;(parent as Record<string, unknown>)[leaf] = value
      }
      this._audit('modify', `${resolvedKey} = ${JSON.stringify(value)}`)
      return `Set ${resolvedKey} = ${JSON.stringify(value)}`
    }
    // Restricted key -> type-checked
    if (resolvedKey in RESTRICTED) {
      return this._modifyRestricted(resolvedKey, value)
    }
    return this._modifyFree(resolvedKey, value)
  }

  private _modifyRestricted(key: string, value: unknown): string {
    const spec = RESTRICTED[key]!
    const expected = spec.type

    if (expected === 'int' && typeof value === 'boolean') {
      return `Error: '${key}' must be number, got boolean`
    }
    if (expected === 'int' && typeof value !== 'number') {
      const num = Number(value)
      if (isNaN(num)) {
        return `Error: '${key}' must be number, got ${typeof value}`
      }
      value = num
    }
    if (expected === 'string' && typeof value !== 'string') {
      value = String(value)
    }

    if (spec.min !== undefined && (value as number) < spec.min) {
      return `Error: '${key}' must be >= ${spec.min}`
    }
    if (spec.max !== undefined && (value as number) > spec.max) {
      return `Error: '${key}' must be <= ${spec.max}`
    }
    if (spec.min_len !== undefined && String(value).length < spec.min_len) {
      return `Error: '${key}' must be at least ${spec.min_len} characters`
    }

    const old = (this._loop as unknown as Record<string, unknown>)[key]
    ;(this._loop as unknown as Record<string, unknown>)[key] = value
    this._audit('modify', `${key}: ${JSON.stringify(old)} -> ${JSON.stringify(value)}`)
    return `Set ${key} = ${JSON.stringify(value)} (was ${JSON.stringify(old)})`
  }

  private _modifyFree(key: string, value: unknown): string {
    const loopObj = this._loop as unknown as Record<string, unknown>
    if (hasRealAttr(this._loop, key)) {
      const old = loopObj[key]
      if (typeof old === 'string' || typeof old === 'number' || typeof old === 'boolean') {
        const oldType = typeof old
        const newType = typeof value
        if (oldType === 'number' && newType === 'number') {
          // ok: number -> number (including int->float coercion)
        } else if (oldType !== newType) {
          this._audit(
            'modify',
            `REJECTED type mismatch ${key}: expects ${oldType}, got ${newType}`,
          )
          return `Error: '${key}' expects ${oldType}, got ${newType}`
        }
      }
      loopObj[key] = value
      this._audit('modify', `${key}: ${JSON.stringify(old)} -> ${JSON.stringify(value)}`)
      return `Set ${key} = ${JSON.stringify(value)} (was ${JSON.stringify(old)})`
    }
    // Store in scratchpad
    if (typeof value === 'function') {
      this._audit('modify', `REJECTED callable ${key}`)
      return 'Error: cannot store callable values'
    }
    const validateErr = MyTool._validateJsonSafe(value)
    if (validateErr) {
      this._audit('modify', `REJECTED ${key}: ${validateErr}`)
      return `Error: ${validateErr}`
    }
    if (!(key in this._loop._runtime_vars) && Object.keys(this._loop._runtime_vars).length >= MAX_RUNTIME_KEYS) {
      this._audit('modify', `REJECTED ${key}: max keys (${MAX_RUNTIME_KEYS}) reached`)
      return `Error: scratchpad is full (max ${MAX_RUNTIME_KEYS} keys). Remove unused keys first.`
    }
    const old = this._loop._runtime_vars[key]
    this._loop._runtime_vars[key] = value
    this._audit('modify', `scratchpad.${key}: ${JSON.stringify(old)} -> ${JSON.stringify(value)}`)
    return `Set scratchpad.${key} = ${JSON.stringify(value)}`
  }

  private static _validateJsonSafe(value: unknown, depth = 0): string | null {
    if (depth > 10) {
      return 'value nesting too deep (max 10 levels)'
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
      return null
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const err = MyTool._validateJsonSafe(value[i], depth + 1)
        if (err) return `list[${i}] contains ${err}`
      }
      return null
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof k !== 'string') {
          return `dict key must be str, got ${typeof k}`
        }
        const err = MyTool._validateJsonSafe(v, depth + 1)
        if (err) return `dict key '${k}' contains ${err}`
      }
      return null
    }
    return `unsupported type ${typeof value}`
  }
}
