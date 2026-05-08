/**
 * Agent system prompt template loading.
 *
 * Port of original Python utils/prompt_templates.py.
 * Agent prompts live under the project's templates/ directory.
 * Uses the built-in TemplateEngine for rendering.
 */

import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TemplateEngine } from './template'

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TEMPLATES_ROOT = join(PROJECT_ROOT, 'templates')

let _engine: TemplateEngine | null = null

function getEngine(): TemplateEngine {
  if (!_engine) {
    _engine = new TemplateEngine(TEMPLATES_ROOT)
  }
  return _engine
}

/**
 * Render an agent prompt template by name.
 *
 * @param name  Template path relative to templates/, e.g. "agent/identity.md"
 * @param strip  Strip trailing whitespace when true
 * @param ctx    Template variables
 */
export function renderTemplate(
  name: string,
  ctx: Record<string, unknown> = {},
  strip = false,
): string {
  const text = getEngine().render(name, ctx)
  return strip ? text.trimEnd() : text
}

/**
 * Check if a template exists.
 */
export function hasTemplate(name: string): boolean {
  return existsSync(join(TEMPLATES_ROOT, name))
}
