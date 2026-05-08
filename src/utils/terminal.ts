/**
 * Terminal management utilities.
 *
 * Port of original Python cli/commands.py terminal helpers:
 * - termios save/restore for clean TTY state
 * - flush pending TTY input
 */

import { isatty } from 'node:tty'
import { openSync, closeSync, readSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { O_RDONLY, O_NONBLOCK } from 'node:constants'

let savedTermSettings = ''

/**
 * Save current terminal attributes for later restoration.
 */
export function saveTerminalAttrs(): void {
  if (!isatty(0)) return
  try {
    savedTermSettings = execSync('stty -g < /dev/tty', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
  } catch {
    savedTermSettings = ''
  }
}

/**
 * Restore terminal to original state.
 */
export function restoreTerminalAttrs(): void {
  if (!isatty(0)) return
  if (savedTermSettings) {
    try {
      execSync(`stty ${savedTermSettings} < /dev/tty`, { stdio: ['pipe', 'pipe', 'ignore'] })
      return
    } catch {
      // fall through to basic restore
    }
  }
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
  } catch {
    // ignore
  }
}

/**
 * Flush any pending/unread terminal input (keypresses typed during output).
 * Uses non-blocking I/O so it never hangs waiting for input.
 */
export function flushPendingTtyInput(): void {
  try {
    if (!isatty(0)) return
  } catch {
    return
  }

  // Drain stdin non-blocking
  try {
    const fd = openSync('/dev/tty', O_RDONLY | O_NONBLOCK)
    const buf = Buffer.alloc(4096)
    for (let i = 0; i < 10; i++) {
      try {
        const n = readSync(fd, buf, 0, 4096, null)
        if (n <= 0) break
      } catch {
        break
      }
    }
    closeSync(fd)
  } catch {
    // Not supported or not a TTY
  }
}
