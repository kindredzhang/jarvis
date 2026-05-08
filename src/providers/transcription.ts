/**
 * Voice transcription providers (Groq and OpenAI Whisper).
 *
 * Port of nanobot/providers/transcription.py.
 */

import { existsSync } from 'node:fs'

export interface TranscriptionProvider {
  transcribe(filePath: string): Promise<string>
}

// ---- OpenAI Whisper ----

export class OpenAITranscriptionProvider implements TranscriptionProvider {
  private apiKey: string
  private apiUrl: string
  private language: string | null

  constructor(opts?: {
    apiKey?: string
    apiBase?: string
    language?: string | null
  }) {
    this.apiKey = opts?.apiKey ?? process.env.OPENAI_API_KEY ?? ''
    this.apiUrl = (
      opts?.apiBase ??
      process.env.OPENAI_TRANSCRIPTION_BASE_URL ??
      'https://api.openai.com/v1/audio/transcriptions'
    )
    this.language = opts?.language ?? null
  }

  async transcribe(filePath: string): Promise<string> {
    if (!this.apiKey) {
      console.warn('[Transcription] OpenAI API key not configured')
      return ''
    }
    if (!existsSync(filePath)) {
      console.error(`[Transcription] Audio file not found: ${filePath}`)
      return ''
    }

    try {
      const file = Bun.file(filePath)
      const formData = new FormData()
      formData.append('file', file)
      formData.append('model', 'whisper-1')
      if (this.language) {
        formData.append('language', this.language)
      }

      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: formData,
      })

      if (!response.ok) {
        console.error(`[Transcription] OpenAI HTTP ${response.status}`)
        return ''
      }

      const data = (await response.json()) as Record<string, unknown>
      return (data.text as string) ?? ''
    } catch (e) {
      console.error(`[Transcription] OpenAI error: ${e}`)
      return ''
    }
  }
}

// ---- Groq Whisper ----

export class GroqTranscriptionProvider implements TranscriptionProvider {
  private apiKey: string
  private apiUrl: string
  private language: string | null

  constructor(opts?: {
    apiKey?: string
    apiBase?: string
    language?: string | null
  }) {
    this.apiKey = opts?.apiKey ?? process.env.GROQ_API_KEY ?? ''
    this.apiUrl = (
      opts?.apiBase ??
      process.env.GROQ_BASE_URL ??
      'https://api.groq.com/openai/v1/audio/transcriptions'
    )
    this.language = opts?.language ?? null
  }

  async transcribe(filePath: string): Promise<string> {
    if (!this.apiKey) {
      console.warn('[Transcription] Groq API key not configured')
      return ''
    }
    if (!existsSync(filePath)) {
      console.error(`[Transcription] Audio file not found: ${filePath}`)
      return ''
    }

    try {
      const file = Bun.file(filePath)
      const formData = new FormData()
      formData.append('file', file)
      formData.append('model', 'whisper-large-v3')
      if (this.language) {
        formData.append('language', this.language)
      }

      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: formData,
      })

      if (!response.ok) {
        console.error(`[Transcription] Groq HTTP ${response.status}`)
        return ''
      }

      const data = (await response.json()) as Record<string, unknown>
      return (data.text as string) ?? ''
    } catch (e) {
      console.error(`[Transcription] Groq error: ${e}`)
      return ''
    }
  }
}

// ---- Factory ----

export function createTranscriptionProvider(
  backend: 'groq' | 'openai' = 'groq',
  opts?: { apiKey?: string; apiBase?: string; language?: string | null },
): TranscriptionProvider {
  if (backend === 'openai') {
    return new OpenAITranscriptionProvider(opts)
  }
  return new GroqTranscriptionProvider(opts)
}
