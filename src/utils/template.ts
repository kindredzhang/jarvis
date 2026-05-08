/** 
 * SimpleTemplateEngine —— 轻量级文本模板
 * 
 * 语法: {{ var }}, {% if %}...{% elif %}...{% else %}...{% endif %},
 *       {% for item in list %}...{% endfor %},
 *       {% include 'path' %}, {% raw %}...{% endraw %}
 *       条件: ==, or, and
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_TPL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates')

function tokenize(s: string): string[] {
  const r: string[] = []; let c = '', i = 0
  while (i < s.length) {
    if (s[i] === '{' && s[i+1] === '%') {
      if (c) { r.push(c); c = '' }
      const e = s.indexOf('%}', i); if (e === -1) { c += s.slice(i); break }
      r.push(s.slice(i, e+2)); i = e + 2
    } else if (s[i] === '{' && s[i+1] === '{') {
      if (c) { r.push(c); c = '' }
      const e = s.indexOf('}}', i); if (e === -1) { c += s.slice(i); break }
      r.push(s.slice(i, e+2)); i = e + 2
    } else if (s[i] === '{' && s[i+1] === '#') {
      if (c) { r.push(c); c = '' }
      const e = s.indexOf('#}', i); if (e === -1) { c += s.slice(i); break }
      i = e + 2
    } else { c += s[i]; i++ }
  }
  if (c) r.push(c)
  return r
}

type Val = Record<string, unknown>
type Node = 
  | { t: 'text'; v: string }
  | { t: 'raw'; v: string }
  | { t: 'var'; v: string }
  | { t: 'if'; cond: string; body: Node[]; elseBody: Node[] }
  | { t: 'for'; var: string; list: string; body: Node[] }
  | { t: 'include'; path: string }

function parse(tk: string[]): Node[] {
  let i = 0
  function walk(): Node[] {
    const block: Node[] = []
    while (i < tk.length) {
      const tok = tk[i]!
      if (tok.startsWith('{%') && tok.endsWith('%}')) {
        const inner = tok.slice(2, -2).trim()
        const parts = inner.split(/\s+/)
        if (parts[0] === 'if') {
          const cond = inner.slice(3).trim()
          i++; const body = walk(); let elseBody: Node[] = []
          // Handle {% elif %} - treat as nested if
          if (i < tk.length) {
            const n = tk[i]!
            if (n.includes('{% elif ')) {
              // Build equivalent: {% else %}{% if COND %}...{% endif %}
              const elifInner = n.slice(2, -2).trim()
              const elifCond = elifInner.slice(5).trim()
              i++ // past elif tag
              const elifBody = walk()
              // Create nested if as the else body
              elseBody = [{ t: 'if' as const, cond: elifCond, body: elifBody, elseBody: [] }]
              // Continue handling more elif/else
              if (i < tk.length) {
                const n2 = tk[i]!
                if (n2.includes('{% else %}')) {
                  i++
                  // The else that follows elif becomes the elseBody of the nested if
                  const finalElse = walk()
                  if (elseBody.length === 1 && elseBody[0]!.t === 'if') {
                    (elseBody[0] as any).elseBody = finalElse
                  }
                }
              }
            } else if (n.includes('{% else %}')) {
              i++; elseBody = walk()
            }
          }
          if (i < tk.length) {
            const n = tk[i]!; if (n.includes('{% endif %}')) i++
          }
          block.push({ t: 'if', cond, body, elseBody })
        } else if (parts[0] === 'for') {
          const m = inner.match(/^for\s+(\w+)\s+in\s+(.+)$/)
          if (m) {
            i++; const body = walk()
            if (i < tk.length && tk[i]!.includes('{% endfor %}')) i++
            block.push({ t: 'for', var: m[1]!, list: m[2]!.trim(), body })
          } else { i++ }
        } else if (inner === 'else' || inner === 'endif' || inner === 'endfor' || inner === 'endraw' || inner.startsWith('elif ')) {
          break
        } else if (inner === 'raw') {
          i++; let raw = ''
          while (i < tk.length) {
            const n = tk[i]!; if (n.includes('{% endraw %}')) break
            raw += n; i++
          }
          i++; block.push({ t: 'raw', v: raw })
        } else if (inner.startsWith('include ')) {
          const p = inner.match(/include\s+['"](.+?)['"]/)
          if (p) block.push({ t: 'include', path: p[1]! })
          i++
        } else { i++ }
      } else if (tok.startsWith('{{') && tok.endsWith('}}')) {
        block.push({ t: 'var', v: tok.slice(2, -2).trim() })
        i++
      } else { block.push({ t: 'text', v: tok }); i++ }
    }
    return block
  }
  return walk()
}

function resolve(expr: string, ctx: Val): unknown {
  let v: unknown = ctx
  for (const k of expr.split('.')) {
    if (v === null || v === undefined) return undefined
    v = (v as Val)[k]
  }
  return v
}

function orParts(expr: string): string[] {
  const parts: string[] = []
  let depth = 0, cur = ''
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === '(') depth++
    else if (expr[i] === ')') depth--
    if (depth === 0 && expr.slice(i, i+4) === ' or ') {
      parts.push(cur.trim()); cur = ''
      i += 4; continue
    }
    cur += expr[i]
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

function andParts(expr: string): string[] {
  const parts: string[] = []
  let depth = 0, cur = ''
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === '(') depth++
    else if (expr[i] === ')') depth--
    if (depth === 0 && expr.slice(i, i+5) === ' and ') {
      parts.push(cur.trim()); cur = ''
      i += 5; continue
    }
    cur += expr[i]
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

function evalCond(expr: string, ctx: Val): boolean {
  for (const orPart of orParts(expr)) {
    let result = true
    for (const andPart of andParts(orPart)) {
      if (!evalSimple(andPart, ctx)) { result = false; break }
    }
    if (result) return true
  }
  return false
}

function evalSimple(expr: string, ctx: Val): boolean {
  const m = expr.match(/^(.+?)\s*==\s*(.+)$/)
  if (m) {
    const l = resolve(m[1]!.trim(), ctx) ?? m[1]!.trim().replace(/^["']|["']$/g, '')
    const r = resolve(m[2]!.trim(), ctx) ?? m[2]!.trim().replace(/^["']|["']$/g, '')
    return String(l) === String(r)
  }
  const raw = resolve(expr.trim(), ctx)
  if (raw !== undefined) {
    if (typeof raw === 'boolean') return raw
    if (typeof raw === 'string') return raw.length > 0
    if (Array.isArray(raw)) return raw.length > 0
    if (typeof raw === 'number') return raw !== 0
    return true
  }
  return false
}

export class TemplateEngine {
  private dir: string
  constructor(d?: string) { this.dir = d ?? PROJECT_TPL_DIR }
  
  render(name: string, ctx: Val = {}): string {
    const fp = join(this.dir, name)
    if (!existsSync(fp)) throw new Error(`Template not found: ${name}`)
    return this.renderString(readFileSync(fp, 'utf-8'), ctx)
  }
  
  renderString(tpl: string, ctx: Val = {}): string {
    const nodes = parse(tokenize(tpl))
    return this._render(nodes, ctx)
  }
  
  private _render(nodes: Node[], ctx: Val): string {
    let out = ''
    for (const n of nodes) {
      if (n.t === 'text') out += n.v
      else if (n.t === 'raw') out += n.v
      else if (n.t === 'var') {
        const v = resolve(n.v, ctx)
        out += v !== null && v !== undefined ? String(v) : ''
      }
      else if (n.t === 'include') out += this.render(n.path, ctx)
      else if (n.t === 'if') {
        if (evalCond(n.cond, ctx)) out += this._render(n.body, ctx)
        else out += this._render(n.elseBody, ctx)
      }
      else if (n.t === 'for') {
        const list = resolve(n.list, ctx)
        if (Array.isArray(list)) {
          for (const item of list) {
            out += this._render(n.body, { ...ctx, [n.var]: item })
          }
        }
      }
    }
    return out
  }
}
