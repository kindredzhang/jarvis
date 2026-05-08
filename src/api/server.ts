/**
 * OpenAI 兼容 API 服务器
 * 提供 /v1/chat/completions 和 /v1/models 端点。
 * 使用 Bun.serve 内置 HTTP 服务器。
 */
import type { AgentLoop } from '../agent/loop'

interface APIConfig { agentLoop: AgentLoop; modelName?: string; port?: number; requestTimeout?: number }

export function createAPIServer(config: APIConfig) {
  const modelName = config.modelName ?? 'jarvis'
  const timeout = config.requestTimeout ?? 120
  const sessionLocks = new Map<string, Promise<void>>()

  async function withLock(key: string, fn: () => Promise<any>) {
    while (sessionLocks.has(key)) await sessionLocks.get(key)
    let release: () => void
    const p = new Promise<void>(resolve => { release = resolve })
    sessionLocks.set(key, p)
    try { return await fn() } finally { sessionLocks.delete(key); release!() }
  }

  return Bun.serve({
    port: config.port ?? 3000,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url)

      if (url.pathname === '/v1/models' && req.method === 'GET') {
        return Response.json({ object: 'list', data: [{ id: modelName, object: 'model', created: 0, owned_by: 'jarvis' }] })
      }

      if (url.pathname === '/health' && req.method === 'GET') {
        return Response.json({ status: 'ok' })
      }

      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        try {
          const body: any = await req.json()
          const messages = body.messages
          const stream = body.stream ?? false
          if (!Array.isArray(messages) || messages.length === 0) {
            return Response.json({ error: { message: 'Invalid messages', type: 'invalid_request_error' } }, { status: 400 })
          }

          const userMsg = messages.find((m: any) => m.role === 'user')
          const text = userMsg?.content ?? ''
          const sessionKey = `api:${body.session_id ?? 'default'}`
          const abortController = new AbortController()
          const timer = setTimeout(() => abortController.abort(), timeout * 1000)

          if (stream) {
            const streamReader = new ReadableStream({
              async start(controller: ReadableStreamDefaultController) {
                try {
                  let streamed = false
                  let result: any = null
                  await withLock(sessionKey, async () => {
                    result = await config.agentLoop.processDirect(text, { sessionKey, callbacks: { onStream(delta: string) { streamed = true; controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: delta }, index: 0 }] })}\n\n`)) }, onStreamEnd() { controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close() } } })
                  })
                  if (!streamed) {
                    const content = result?.content ?? ''
                    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content }, index: 0, finish_reason: 'stop' }] })}\n\n`))
                    controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
                    controller.close()
                  }
                } catch { controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close() } finally { clearTimeout(timer) }
              }
            })
            return new Response(streamReader, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } })
          }

          const response = await withLock(sessionKey, async () => { return config.agentLoop.processDirect(text, { sessionKey }) })
          clearTimeout(timer)
          const content = response?.content ?? ''
          return Response.json({ id: `chatcmpl-${Math.random().toString(36).slice(2, 14)}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: modelName, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })
        } catch (e: any) { return Response.json({ error: { message: e.message, type: 'server_error' } }, { status: 500 }) }
      }

      return new Response('Not Found', { status: 404 })
    },
  })
}
