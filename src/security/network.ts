/**
 * Network security utilities — SSRF protection and internal URL detection.
 *
 * Ported from Python original security/network.py.
 */

import { resolve4, resolve6 } from 'node:dns/promises'
import { isIP } from 'node:net'

// ---- CIDR IP network matching ----

interface IPNetwork {
  contains(addr: string): boolean
}

function parseCIDRv4(base: string, bits: number): IPNetwork | null {
  const parts = base.split('.').map(Number)
  if (parts.length !== 4 || parts.some(isNaN)) return null
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  const network =
    ((parts[0]! << 24) >>> 0) +
    ((parts[1]! << 16) >>> 0) +
    ((parts[2]! << 8) >>> 0) +
    parts[3]!
  const masked = network & mask

  return {
    contains(addr: string): boolean {
      if (isIP(addr) !== 4) return false
      const p = addr.split('.').map(Number)
      if (p.length !== 4 || p.some(isNaN)) return false
      const ip =
        ((p[0]! << 24) >>> 0) +
        ((p[1]! << 16) >>> 0) +
        ((p[2]! << 8) >>> 0) +
        p[3]!
      return (ip & mask) >>> 0 === masked >>> 0
    },
  }
}

function expandIPv6(addr: string): string | null {
  if (addr === '::') return '0000:0000:0000:0000:0000:0000:0000:0000'
  if (addr.startsWith('::')) addr = '0' + addr
  if (addr.endsWith('::')) addr = addr + '0'

  const parts = addr.split(':')
  if (parts.length > 8) return null

  const insertIdx = parts.indexOf('')
  if (insertIdx !== -1) {
    const missing = 8 - parts.length + 1
    parts.splice(insertIdx, 1, ...Array(missing).fill('0'))
  }
  if (parts.length !== 8) return null

  return parts.map((p) => p.padStart(4, '0')).join(':')
}

function hexToBigInt(hex: string): bigint {
  return BigInt('0x' + (hex || '0'))
}

function parseCIDRv6(base: string, bits: number): IPNetwork | null {
  const full = expandIPv6(base)
  if (!full) return null

  const mask = bits === 0 ? BigInt(0) : (~BigInt(0) << BigInt(128 - bits))
  const network = hexToBigInt(full.replace(/:/g, '')) & mask

  return {
    contains(addr: string): boolean {
      if (isIP(addr) !== 6) return false
      const expanded = expandIPv6(addr)
      if (!expanded) return false
      const ip = hexToBigInt(expanded.replace(/:/g, ''))
      return (ip & mask) === network
    },
  }
}

function parseCIDR(cidr: string): IPNetwork | null {
  const idx = cidr.indexOf('/')
  if (idx === -1) return null
  const base = cidr.slice(0, idx)
  const bitsStr = cidr.slice(idx + 1)
  const bits = parseInt(bitsStr, 10)
  if (isNaN(bits)) return null

  if (base.includes(':')) return parseCIDRv6(base, bits)
  return parseCIDRv4(base, bits)
}

// ---- Blocked networks ----

const _BLOCKED_NETWORKS: IPNetwork[] = [
  parseCIDR('0.0.0.0/8')!,
  parseCIDR('10.0.0.0/8')!,
  parseCIDR('100.64.0.0/10')!,
  parseCIDR('127.0.0.0/8')!,
  parseCIDR('169.254.0.0/16')!,
  parseCIDR('172.16.0.0/12')!,
  parseCIDR('192.168.0.0/16')!,
  parseCIDR('::1/128')!,
  parseCIDR('fc00::/7')!,
  parseCIDR('fe80::/10')!,
]

const _URL_RE = /https?:\/\/[^\s"'`;|<>]+/gi

let _allowedNetworks: IPNetwork[] = []

/**
 * Allow specific CIDR ranges to bypass SSRF blocking (e.g. Tailscale's 100.64.0.0/10).
 */
export function configureSSRFWhitelist(cidrs: string[]): void {
  const nets: IPNetwork[] = []
  for (const cidr of cidrs) {
    const net = parseCIDR(cidr)
    if (net) nets.push(net)
  }
  _allowedNetworks = nets
}

function isPrivate(addr: string): boolean {
  if (_allowedNetworks.length > 0 && _allowedNetworks.some((n) => n.contains(addr))) {
    return false
  }
  return _BLOCKED_NETWORKS.some((n) => n.contains(addr))
}

/**
 * Resolve a hostname to all IPs (v4 and v6).
 */
async function resolveHost(hostname: string): Promise<string[]> {
  const ips: string[] = []
  try {
    const v4 = await resolve4(hostname)
    ips.push(...v4)
  } catch {
    // no v4 records
  }
  try {
    const v6 = await resolve6(hostname)
    ips.push(...v6)
  } catch {
    // no v6 records
  }
  return ips
}

/**
 * Validate a URL is safe to fetch: scheme, hostname, and resolved IPs.
 *
 * Returns { ok, error }. When ok is true, error is empty.
 */
export async function validateURLTarget(url: string): Promise<{ ok: boolean; error: string }> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (e) {
    return { ok: false, error: String(e) }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `Only http/https allowed, got '${parsed.protocol || 'none'}'` }
  }
  if (!parsed.hostname) {
    return { ok: false, error: 'Missing hostname' }
  }

  const hostname = parsed.hostname

  // If hostname is already an IP literal, check directly
  if (isIP(hostname)) {
    if (isPrivate(hostname)) {
      return { ok: false, error: `Blocked: ${hostname} is a private/internal address` }
    }
    return { ok: true, error: '' }
  }

  // Resolve DNS
  let ips: string[]
  try {
    ips = await resolveHost(hostname)
  } catch {
    return { ok: false, error: `Cannot resolve hostname: ${hostname}` }
  }

  if (ips.length === 0) {
    return { ok: false, error: `Cannot resolve hostname: ${hostname}` }
  }

  for (const addr of ips) {
    if (isPrivate(addr)) {
      return { ok: false, error: `Blocked: ${hostname} resolves to private/internal address ${addr}` }
    }
  }

  return { ok: true, error: '' }
}

/**
 * Validate an already-fetched URL (e.g. after redirect). Only checks the IP, skips DNS.
 */
export async function validateResolvedURL(url: string): Promise<{ ok: boolean; error: string }> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: true, error: '' }
  }

  const hostname = parsed.hostname
  if (!hostname) return { ok: true, error: '' }

  // If hostname is already an IP literal
  if (isIP(hostname)) {
    if (isPrivate(hostname)) {
      return { ok: false, error: `Redirect target is a private address: ${hostname}` }
    }
    return { ok: true, error: '' }
  }

  // Resolve DNS
  try {
    const ips = await resolveHost(hostname)
    for (const addr of ips) {
      if (isPrivate(addr)) {
        return { ok: false, error: `Redirect target ${hostname} resolves to private address ${addr}` }
      }
    }
  } catch {
    // ignore resolution failures for redirect validation
  }

  return { ok: true, error: '' }
}

/**
 * Return true if the command string contains a URL targeting an internal/private address.
 */
export async function containsInternalURL(command: string): Promise<boolean> {
  const matches = command.match(_URL_RE)
  if (!matches) return false
  for (const url of matches) {
    const result = await validateURLTarget(url)
    if (!result.ok) return true
  }
  return false
}
