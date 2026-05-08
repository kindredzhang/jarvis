/**
 * Persistent file history for interactive CLI input.
 *
 * Port of Python original SafeFileHistory (prompt_toolkit FileHistory subclass
 * with surrogate character sanitization).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export class FileHistory {
  private _filePath: string
  private _maxEntries: number
  private _entries: string[] = []
  private _loaded = false

  constructor(filePath: string, maxEntries = 1000) {
    this._filePath = filePath
    this._maxEntries = maxEntries
  }

  private _load(): void {
    if (this._loaded) return
    this._loaded = true
    if (!existsSync(this._filePath)) return
    try {
      const text = readFileSync(this._filePath, 'utf-8')
      this._entries = text.split('\n').filter(Boolean).reverse().slice(0, this._maxEntries)
    } catch {
      this._entries = []
    }
  }

  /** Return stored entries in display order (newest first, for navigation). */
  get entries(): string[] {
    this._load()
    return this._entries
  }

  /** Return stored entries in chronological order (oldest first, for readline). */
  get reversed(): string[] {
    this._load()
    return [...this._entries].reverse()
  }

  /** Append a line to the history file, sanitizing bad characters. */
  storeString(text: string): void {
    if (!text) return
    // Sanitize surrogate characters (same as Python original SafeFileHistory)
    const safe = text
      .normalize('NFC')
      .replace(/[\uD800-\uDFFF]/g, '?')
    const dir = dirname(this._filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    try {
      appendFileSync(this._filePath, safe + '\n', 'utf-8')
    } catch {
      // Silently fail on write errors
    }
    this._load()
    this._entries.unshift(text)
    if (this._entries.length > this._maxEntries) {
      this._entries = this._entries.slice(0, this._maxEntries)
      try {
        writeFileSync(this._filePath, [...this._entries].reverse().join('\n') + '\n', 'utf-8')
      } catch {
        // Ignore write errors
      }
    }
  }
}
