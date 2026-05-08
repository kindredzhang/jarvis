import { test, expect, describe } from 'bun:test'
import { TemplateEngine } from './template'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const engine = new TemplateEngine()

describe('TemplateEngine', () => {
  test('simple variable interpolation', () => {
    const result = engine.renderString('Hello, {{ name }}!', { name: 'World' })
    expect(result).toBe('Hello, World!')
  })

  test('multiple variables', () => {
    const result = engine.renderString('{{a}} + {{b}} = {{c}}', { a: 1, b: 2, c: 3 })
    expect(result).toBe('1 + 2 = 3')
  })

  test('nested dot notation', () => {
    const result = engine.renderString('{{user.name}} is {{user.age}}', {
      user: { name: 'Alice', age: 30 },
    })
    expect(result).toBe('Alice is 30')
  })

  test('if condition true', () => {
    const result = engine.renderString('{% if show %}visible{% endif %}', { show: true })
    expect(result).toBe('visible')
  })

  test('if condition false', () => {
    const result = engine.renderString('{% if show %}visible{% endif %}', { show: false })
    expect(result).toBe('')
  })

  test('if-else', () => {
    const result = engine.renderString(
      '{% if x %}yes{% else %}no{% endif %}',
      { x: false },
    )
    expect(result).toBe('no')
  })

  test('if-elif-else', () => {
    const result = engine.renderString(
      '{% if x == 1 %}one{% elif x == 2 %}two{% else %}other{% endif %}',
      { x: 2 },
    )
    expect(result).toBe('two')
  })

  test('for loop', () => {
    const result = engine.renderString(
      '{% for item in items %}{{ item }},{% endfor %}',
      { items: ['a', 'b', 'c'] },
    )
    expect(result).toBe('a,b,c,')
  })

  test('if condition with or', () => {
    const result = engine.renderString(
      '{% if channel == "cli" or channel == "terminal" %}plain text{% endif %}',
      { channel: 'cli' },
    )
    expect(result).toBe('plain text')
  })

  test('include template', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tpl-'))
    writeFileSync(join(dir, '_greeting.md'), 'Hello, {{ name }}!')

    const engine2 = new TemplateEngine(dir)
    const result = engine2.render('_greeting.md', { name: 'World' })
    expect(result).toBe('Hello, World!')

    rmSync(dir, { recursive: true, force: true })
  })

  test('raw block ignores template syntax', () => {
    const result = engine.renderString(
      'before {% raw %}{{ not_parsed }}{% endraw %} after',
      { not_parsed: 'x' },
    )
    expect(result).toBe('before {{ not_parsed }} after')
  })

  test('comment is removed', () => {
    const result = engine.renderString('before{# comment #}after', {})
    expect(result).toBe('beforeafter')
  })

  test('undefined variable renders empty', () => {
    const result = engine.renderString('{{ missing }}', {})
    expect(result).toBe('')
  })

  test('empty string keeps text', () => {
    const result = engine.renderString('plain text', {})
    expect(result).toBe('plain text')
  })

  test('complex nested context', () => {
    const tpl = '{% if user.enabled %}{{ user.name }} ({{ user.details.role }}){% endif %}'
    const result = engine.renderString(tpl, {
      user: { enabled: true, name: 'Admin', details: { role: 'admin' } },
    })
    expect(result).toBe('Admin (admin)')
  })
})
