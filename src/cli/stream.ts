/**
 * Streaming renderer for CLI output.
 *
 * Port of nanobot/cli/stream.py. Uses marked-terminal for rich.Markdown-
 * equivalent rendering, chalk for ANSI styling, and manual cursor control
 * for flicker-free live updates (equivalent to rich.Live auto_refresh=False).
 *
 * Flow per round:
 *   spinner -> first visible delta -> header + live renders ->
 *   on_end -> live stops (content stays on screen)
 */

import { marked } from 'marked'
import { markedTerminal } from 'marked-terminal'
import chalk from 'chalk'

// Apply terminal renderer to marked
marked.use(markedTerminal({ unescape: true }))

function isTTY(): boolean {
  return process.stdout.isTTY ?? false
}

// ---- Helpers ----

function renderMarkdown(text: string): string {
  if (!text.trim()) return ''
  try {
    return marked.parse(text, { async: false }) as string
  } catch {
    return text
  }
}

// ========================================================================
// ThinkingSpinner
// ========================================================================

/**
 * Spinner that shows "jarvis is thinking..." with pause support.
 *
 * Port of nanobot's ThinkingSpinner (rich.console.Status wrapper).
 */
export class ThinkingSpinner {
  private _interval: ReturnType<typeof setInterval> | null = null
  private _active = false
  private _frameIndex = 0
  private _frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  private _statusText = 'jarvis is thinking...'

  start(): void {
    if (!isTTY() || this._active) return
    this._active = true

    const frame = () => {
      if (!this._active) return
      const f = this._frames[this._frameIndex % this._frames.length]
      this._frameIndex++
      process.stdout.write(`\r${f} ${chalk.dim(this._statusText)}`)
    }

    frame()
    this._interval = setInterval(frame, 80)
  }

  stop(): void {
    if (!this._active) return
    this._active = false
    if (this._interval) {
      clearInterval(this._interval)
      this._interval = null
    }
    process.stdout.write('\r\x1b[2K\r') // clear line, reset cursor
  }

  /** Update the status text shown next to the spinner. */
  setStatus(text: string): void {
    this._statusText = text
    if (this._active) {
      const f = this._frames[this._frameIndex % this._frames.length]
      process.stdout.write(`\r${f} ${chalk.dim(text)}`)
    }
  }

  /**
   * Context manager: temporarily stop spinner for clean output.
   * Returns a resume function.
   *
   * Port of nanobot's ThinkingSpinner.pause() (contextmanager).
   */
  pause(): () => void {
    if (this._active) {
      this.stop()
      return () => this.start()
    }
    return () => {}
  }

  get active(): boolean {
    return this._active
  }
}

// ========================================================================
// StreamRenderer
// ========================================================================

const LINE_CLEAR = '\x1b[2K'
const CURSOR_UP = '\x1b[A'

function countAnsiFreeLines(text: string): number {
  // Strip ANSI codes for line counting
  const clean = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
  return clean.split('\n').length
}

/**
 * Streaming markdown renderer for CLI output.
 *
 * Accumulates text deltas and updates the terminal display with
 * throttled refresh (min 150ms between updates).
 *
 * Port of nanobot's StreamRenderer which uses rich.Live(auto_refresh=False).
 */
export class StreamRenderer {
  private _renderMarkdown: boolean
  private _renderAs: 'markdown' | 'text' = 'markdown'
  private _buf = ''
  private _headerPrinted = false
  private _renderedLines = 0
  private _lastRefresh = 0
  private _throttleMs: number
  private _spinner: ThinkingSpinner
  private _spinnerEnabled: boolean
  streamed = false

  constructor(opts?: {
    renderMarkdown?: boolean
    renderAs?: 'markdown' | 'text'
    showSpinner?: boolean
    throttleMs?: number
  }) {
    this._renderMarkdown = opts?.renderMarkdown ?? true
    this._renderAs = opts?.renderAs ?? 'markdown'
    this._throttleMs = opts?.throttleMs ?? 150
    this._spinnerEnabled = opts?.showSpinner ?? true
    this._spinner = new ThinkingSpinner()
    if (this._spinnerEnabled) {
      this._spinner.start()
    }
  }

  /**
   * Set render mode for metadata-driven display.
   */
  setRenderAs(mode: 'markdown' | 'text'): void {
    this._renderAs = mode
  }

  private _render(): string {
    const useMarkdown = this._renderMarkdown && this._renderAs !== 'text'
    const body = useMarkdown ? renderMarkdown(this._buf) : this._buf
    const header = chalk.cyan('jarvis:')
    return body ? `${header} ${body}` : header
  }

  private _refresh(): void {
    const now = Date.now()
    if (now - this._lastRefresh < this._throttleMs) return
    this._lastRefresh = now

    const content = this._render()
    if (!content) return

    const newLines = countAnsiFreeLines(content)

    if (this._renderedLines > 0) {
      // Cursor up to the start of our output block
      process.stdout.write(CURSOR_UP.repeat(this._renderedLines))
    }

    // Write each line, clearing first for variable-width content
    const lines = content.split('\n')
    for (const line of lines) {
      process.stdout.write(LINE_CLEAR + line + '\n')
    }

    this._renderedLines = newLines
  }

  async onDelta(delta: string): Promise<void> {
    this.streamed = true
    this._buf += delta

    if (!this._headerPrinted) {
      if (!this._buf.trim()) return
      this._spinner.stop()
      process.stdout.write('\n') // blank line before header
      this._headerPrinted = true
    }

    this._refresh()
  }

  async onEnd(opts?: { resuming?: boolean }): Promise<void> {
    const resuming = opts?.resuming ?? false

    if (this._headerPrinted) {
      // Final render
      const content = this._render()
      if (content) {
        const newLines = countAnsiFreeLines(content)
        if (this._renderedLines > 0) {
          process.stdout.write(CURSOR_UP.repeat(this._renderedLines))
        }
        const lines = content.split('\n')
        for (const line of lines) {
          process.stdout.write(LINE_CLEAR + line + '\n')
        }
        // Clear any leftover lines from previous larger render
        if (newLines < this._renderedLines) {
          const leftover = this._renderedLines - newLines
          for (let i = 0; i < leftover; i++) {
            process.stdout.write(LINE_CLEAR + '\n')
          }
          process.stdout.write(CURSOR_UP.repeat(leftover))
        }
      }
      this._renderedLines = 0
      this._headerPrinted = false
    }

    this._spinner.stop()

    if (resuming) {
      this._buf = ''
      if (this._spinnerEnabled) {
        this._spinner.start()
      }
    } else {
      process.stdout.write('\n')
    }
  }

  /** Stop spinner before user input to avoid display conflicts. */
  stopForInput(): void {
    this._spinner.stop()
  }

  /**
   * Show tool progress or status updates during agent execution.
   * Updates the spinner text for tool hints, pauses spinner for messages.
   */
  onProgress(content: string, opts?: { toolHint?: boolean }): void {
    if (opts?.toolHint) {
      this._spinner.setStatus(content)
    } else {
      const resume = this._spinner.pause()
      process.stderr.write(`  ${chalk.dim(`↳ ${content}`)}\n`)
      resume()
    }
  }

  async close(): Promise<void> {
    this._spinner.stop()
    this._renderedLines = 0
    this._headerPrinted = false
  }
}
