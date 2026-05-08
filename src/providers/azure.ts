/**
 * Azure OpenAI provider — uses the Responses API endpoint.
 *
 * Port of original Python providers/azure_openai_provider.py.
 *
 * Endpoint: {api_base}/openai/v1/responses
 * Model name = Azure deployment name.
 */

import { LLMProvider } from './base'
import { convertMessages, convertTools } from './openai-responses/converters'
import { parseResponseOutput, type ParsedResponse } from './openai-responses/parsing'
import type { Message, LLMResponse, LLMResponseChunk, GenerationSettings } from './types'
import type { ToolDefinition } from '../agent/tools/base'

export class AzureProvider extends LLMProvider {
  readonly model: string
  readonly apiKey: string
  readonly apiBase: string
  private _client: { apiKey: string; baseUrl: string }

  constructor(opts: {
    apiKey: string
    apiBase: string
    model?: string
  }) {
    super()
    if (!opts.apiKey) throw new Error('Azure OpenAI api_key is required')
    if (!opts.apiBase) throw new Error('Azure OpenAI api_base is required')

    this.apiKey = opts.apiKey
    this.apiBase = opts.apiBase.endsWith('/') ? opts.apiBase : opts.apiBase + '/'
    this.model = opts.model ?? 'gpt-5.2-chat'

    this._client = {
      apiKey: this.apiKey,
      baseUrl: `${this.apiBase}openai/v1/`,
    }
  }

  private get _responsesUrl(): string {
    return `${this._client.baseUrl}responses`
  }

  private _supportsTemperature(deployment: string, reasoningEffort?: string | null): boolean {
    if (reasoningEffort) return false
    const name = deployment.toLowerCase()
    return !['gpt-5', 'o1', 'o3', 'o4'].some((t) => name.includes(t))
  }

  private _buildBody(
    messages: Message[],
    tools: ToolDefinition[] | undefined,
    settings?: GenerationSettings,
  ): Record<string, unknown> {
    const rawMsgs = messages as unknown as Record<string, unknown>[]
    const sanitized = LLMProvider.sanitizeEmptyContent(rawMsgs)
    const [instructions, inputItems] = convertMessages(sanitized)

    const body: Record<string, unknown> = {
      model: this.model,
      instructions: instructions || null,
      input: inputItems,
      max_output_tokens: Math.max(1, settings?.maxTokens ?? 4096),
      store: false,
      stream: false,
    }

    const temp = settings?.temperature ?? 0.7
    if (this._supportsTemperature(this.model, settings?.reasoningEffort)) {
      body.temperature = temp
    }

    if (settings?.reasoningEffort) {
      body.reasoning = { effort: settings.reasoningEffort }
      body.include = ['reasoning.encrypted_content']
    }

    if (tools && tools.length > 0) {
      body.tools = convertTools(tools as unknown as Record<string, unknown>[])
      body.tool_choice = 'auto'
    }

    return body
  }

  private async _request(
    body: Record<string, unknown>,
  ): Promise<Response> {
    const response = await fetch(this._responsesUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': this.apiKey,
      },
      body: JSON.stringify(body),
    })
    return response
  }

  private _handleError(error: unknown): LLMResponse {
    let bodyText = ''
    let retryAfter: number | null = null

    if (error instanceof Response) {
      // Already handled in _request
    } else if (error instanceof Error) {
      bodyText = error.message.slice(0, 500)
    }

    const msg = bodyText ? `Error: ${bodyText}` : `Error calling Azure OpenAI: ${error}`
    return {
      content: msg,
      finishReason: 'error',
      toolCalls: [],
      retryAfter,
    }
  }

  // ---- Public API ----

  async generate(
    messages: Message[],
    options?: { tools?: ToolDefinition[]; settings?: GenerationSettings },
  ): Promise<LLMResponse> {
    const body = this._buildBody(messages, options?.tools, options?.settings)

    try {
      const resp = await this._request(body)
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        const retryAfter = LLMProvider.extractRetryAfterFromHeaders(
          Object.fromEntries(resp.headers.entries()),
        )
        return {
          content: `Error: HTTP ${resp.status}${text ? `: ${text.slice(0, 500)}` : ''}`,
          finishReason: 'error',
          toolCalls: [],
          retryAfter,
          errorStatus: resp.status,
        }
      }

      const json = (await resp.json()) as Record<string, unknown>
      const parsed: ParsedResponse = parseResponseOutput(json)

      const usage = parsed.usage
        ? { promptTokens: parsed.usage.promptTokens ?? 0, completionTokens: parsed.usage.completionTokens ?? 0, totalTokens: parsed.usage.totalTokens ?? 0 }
        : undefined

      return {
        content: parsed.content,
        finishReason: parsed.finishReason as LLMResponse['finishReason'],
        toolCalls: parsed.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
        usage,
        reasoningContent: parsed.reasoningContent,
      }
    } catch (e) {
      return this._handleError(e)
    }
  }

  async *generateStream(
    messages: Message[],
    options?: { tools?: ToolDefinition[]; settings?: GenerationSettings },
  ): AsyncIterable<LLMResponseChunk> {
    const body = this._buildBody(messages, options?.tools, options?.settings)
    body.stream = true

    let resp: Response
    try {
      resp = await this._request(body)
    } catch (e) {
      yield {
        content: `Error: ${e}`,
        finishReason: 'error',
        toolCalls: [],
      }
      return
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      yield {
        content: `Error: HTTP ${resp.status}: ${text.slice(0, 500)}`,
        finishReason: 'error',
        toolCalls: [],
      }
      return
    }

    if (!resp.body) {
      yield { content: null, finishReason: 'error', toolCalls: [] }
      return
    }

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const parts = buffer.split('\n\n')
      for (const part of parts.slice(0, -1)) {
        const lines = part.trim().split('\n')
        let data = ''
        for (const line of lines) {
          if (line.startsWith('data:')) {
            data += line.slice(5).trim()
          }
        }
        if (!data || data === '[DONE]') continue

        try {
          const evt = JSON.parse(data) as Record<string, unknown>
          const evtType = evt.type as string

          if (evtType === 'response.output_text.delta') {
            const delta = (evt.delta as string) ?? ''
            yield { content: delta, finishReason: null, toolCalls: [] }
          } else if (evtType === 'response.completed') {
            const respObj = (evt.response as Record<string, unknown>) ?? {}
            const status = respObj.status as string | null
            if (status === 'failed' || status === 'cancelled') {
              yield { content: null, finishReason: 'error', toolCalls: [] }
            }
          } else if (evtType === 'error' || evtType === 'response.failed') {
            yield { content: null, finishReason: 'error', toolCalls: [] }
          }
        } catch {
          // skip unparseable events
        }
      }
      buffer = parts[parts.length - 1] ?? ''
    }
  }
}
