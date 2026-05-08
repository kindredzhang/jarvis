/**
 * Shared helpers for decoding `data:...;base64,...` URLs to disk.
 *
 * Port of original Python utils/media_decode.py.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const DATA_URL_RE = /^data:([^;]+);base64,(.+)$/s
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024

export class FileSizeExceeded extends Error {
  constructor(limitBytes: number) {
    super(`File exceeds ${limitBytes / (1024 * 1024)}MB limit`)
  }
}

function guessExtension(mimeType: string): string {
  const mimeToExt: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/ogg': '.ogg',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'application/pdf': '.pdf',
    'application/json': '.json',
    'text/plain': '.txt',
    'text/html': '.html',
    'text/csv': '.csv',
  }
  return mimeToExt[mimeType] || '.bin'
}

function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_')
}

/**
 * Decode a `data:<mime>;base64,<payload>` URL and persist it.
 *
 * Returns the absolute path on success, `null` on malformed input.
 * Throws FileSizeExceeded when decoded payload exceeds maxBytes.
 */
export function saveBase64DataUrl(
  dataUrl: string,
  mediaDir: string,
  maxBytes?: number,
): string | null {
  const m = DATA_URL_RE.exec(dataUrl)
  if (!m) return null

  const mimeType = m[1]!
  const b64Payload = m[2]!

  // Validate base64 characters (strict mode — reject invalid characters)
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64Payload)) {
    return null
  }

  let raw: Uint8Array
  try {
    raw = Buffer.from(b64Payload, 'base64')
  } catch {
    return null
  }

  const limit = maxBytes ?? DEFAULT_MAX_BYTES
  if (raw.length > limit) {
    throw new FileSizeExceeded(limit)
  }

  const ext = guessExtension(mimeType)
  const filename = `${randomUUID().replace(/-/g, '').slice(0, 12)}${ext}`
  const dest = join(mediaDir, safeFilename(filename))

  mkdirSync(mediaDir, { recursive: true })
  writeFileSync(dest, raw)
  return dest
}
