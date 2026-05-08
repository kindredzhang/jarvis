/**
 * 网络安全 —— SSRF 防护和内网 URL 检测
 */
import { URL } from 'node:url'

const PRIVATE_RANGES = [
  { start: '0.0.0.0', end: '0.255.255.255' },
  { start: '10.0.0.0', end: '10.255.255.255' },
  { start: '100.64.0.0', end: '100.127.255.255' },
  { start: '127.0.0.0', end: '127.255.255.255' },
  { start: '169.254.0.0', end: '169.254.255.255' },
  { start: '172.16.0.0', end: '172.31.255.255' },
  { start: '192.168.0.0', end: '192.168.255.255' },
  { start: '::1', end: '::1' },
  { start: 'fc00::', end: 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff' },
]

function ipToNum(ip: string): bigint {
  const parts = ip.split('.').map(Number)
  if (parts.length === 4) return ((BigInt(parts[0]!) << 24n) | (BigInt(parts[1]!) << 16n) | (BigInt(parts[2]!) << 8n) | BigInt(parts[3]!))
  // IPv6 not fully implemented, treat as non-private
  return 0n
}

function isPrivate(ip: string): boolean {
  const num = ipToNum(ip)
  if (num === 0n) return false
  for (const r of PRIVATE_RANGES) {
    if (num >= ipToNum(r.start) && num <= ipToNum(r.end)) return true
  }
  return false
}

const URL_RE = /https?:\/\/[^\s"'`;|<>]+/gi

/** 验证 URL 目标是否安全（防 SSRF） */
export function validateURLTarget(url: string): [boolean, string] {
  try {
    const p = new URL(url)
    if (p.protocol !== 'http:' && p.protocol !== 'https:') return [false, `Only http/https allowed, got '${p.protocol}'`]
    if (!p.hostname) return [false, 'Missing hostname']
    if (isPrivate(p.hostname)) return [false, `Blocked: ${url} resolves to private address`]
    return [true, '']
  } catch (e) { return [false, String(e)] }
}

/** 检查命令字符串是否包含内网 URL */
export function containsInternalURL(command: string): boolean {
  const matches = command.match(URL_RE)
  if (!matches) return false
  for (const url of matches) {
    const [ok] = validateURLTarget(url)
    if (!ok) return true
  }
  return false
}
