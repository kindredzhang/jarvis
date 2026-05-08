/**
 * SkillsLoader —— 技能加载器
 *
 * 管理工作区和内置技能的 SKILL.md 文件。
 * 提供技能列表、摘要、元数据提取、始终加载等功能。
 *
 * ========= TODO: 与 Python 原版差异标注 =========
 * - 无 YAML 解析器（当前用正则提取 frontmatter 字段）
 * - 无 _parse_jarvis_metadata 元数据嵌套解析
 * - 无 shutil.which 依赖检查（bins 检查跳过）
 * - 无 YAML frontmatter 写回
 * - 无 _strip_frontmatter 对非 --- 开头的容错
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 从 frontmatter 中提取 key: value 字段 */
function extractFrontmatterField(content: string, key: string): string | null {
  if (!content.startsWith('---')) return null
  const end = content.indexOf('---', 3)
  if (end === -1) return null
  const frontmatter = content.slice(3, end)
  const regex = new RegExp(`^${key}:\\s*(.+)$`, 'm')
  const match = frontmatter.match(regex)
  if (!match) return null
  const first = match[1]
  return first?.trim() ?? null
}

/** 从 frontmatter 中提取 always 布尔值 */
function extractAlwaysFlag(content: string): boolean {
  const val = extractFrontmatterField(content, 'always')
  return val === 'true' || val === 'yes'
}

/** 从 frontmatter 中提取 requires 块 */
function extractRequires(content: string): { bins: string[]; env: string[] } {
  if (!content.startsWith('---')) return { bins: [], env: [] }
  const end = content.indexOf('---', 3)
  if (end === -1) return { bins: [], env: [] }
  const frontmatter = content.slice(3, end)
  // 简单提取 requires: 后的多行列表
  const requiresMatch = frontmatter.match(/^requires:\s*$/m)
  if (!requiresMatch) return { bins: [], env: [] }
  const after = frontmatter.slice(requiresMatch.index! + requiresMatch[0].length)
  const bins: string[] = []
  const env: string[] = []
  for (const line of after.split('\n')) {
    const binMatch = line.match(/^\s{2,}bins:\s*\[(.*)\]$/)
    if (binMatch && binMatch[1]) {
      bins.push(...binMatch[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean))
    }
    const envMatch = line.match(/^\s{2,}env:\s*\[(.*)\]$/)
    if (envMatch && envMatch[1]) {
      env.push(...envMatch[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean))
    }
  }
  return { bins, env }
}

/** 项目内置技能目录 */
const PROJECT_SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills')
/** 用户级 skill 目录 ~/.jarvis/skills */
const USER_SKILLS_DIR = join(process.env.HOME ?? '~', '.jarvis', 'skills')

export interface SkillEntry {
  name: string
  path: string
  source: 'workspace' | 'builtin'
}

export class SkillsLoader {
  private workspace: string
  private builtinDirs: string[]
  private disabledSkills: Set<string>

  constructor(options: {
    workspace: string
    disabledSkills?: string[]
    builtinDirs?: string[]
  }) {
    this.workspace = options.workspace
    this.builtinDirs = options.builtinDirs ?? [PROJECT_SKILLS_DIR, USER_SKILLS_DIR]
    this.disabledSkills = new Set(options.disabledSkills ?? [])
  }

  /** 列出所有可用技能 */
  listSkills(filterUnavailable = true): SkillEntry[] {
    const workspaceSkills = this._entriesFromDir(
      join(this.workspace, 'skills'),
      'workspace' as const,
    )
    const workspaceNames = new Set(workspaceSkills.map((s) => s.name))

    const builtinSkills: SkillEntry[] = []
    const seenBuiltin = new Set(workspaceNames)
    for (const dir of this.builtinDirs) {
      if (existsSync(dir)) {
        const entries = this._entriesFromDir(dir, 'builtin' as const, seenBuiltin)
        for (const e of entries) { seenBuiltin.add(e.name); builtinSkills.push(e) }
      }
    }

    const all = [...workspaceSkills, ...builtinSkills]
      .filter((s) => !this.disabledSkills.has(s.name))

    if (filterUnavailable) {
      return all.filter((s) => this._checkRequirements(s.name))
    }
    return all
  }

  /** 加载单个技能内容 */
  loadSkill(name: string): string | null {
    const roots = [join(this.workspace, 'skills')]
    for (const dir of this.builtinDirs) {
      if (existsSync(dir)) roots.push(dir)
    }
    for (const root of roots) {
      const path = join(root, name, 'SKILL.md')
      if (existsSync(path)) {
        return readFileSync(path, 'utf-8')
      }
    }
    return null
  }

  /** 加载指定技能列表的内容（用于上下文注入） */
  loadSkillsForContext(skillNames: string[]): string {
    const parts: string[] = []
    for (const name of skillNames) {
      const content = this.loadSkill(name)
      if (content) {
        const stripped = this._stripFrontmatter(content)
        parts.push(`### Skill: ${name}\n\n${stripped}`)
      }
    }
    return parts.join('\n\n---\n\n')
  }

  /** 构建技能摘要（供 LLM 渐进加载用） */
  buildSkillsSummary(exclude?: Set<string>): string {
    const all = this.listSkills(false)
    if (all.length === 0) return ''

    const lines: string[] = []
    for (const entry of all) {
      if (exclude?.has(entry.name)) continue
      const desc = this._getDescription(entry.name)
      const available = this._checkRequirements(entry.name)
      if (available) {
        lines.push(`- **${entry.name}** — ${desc}  \`${entry.path}\``)
      } else {
        lines.push(`- **${entry.name}** — ${desc} (requirements not met)  \`${entry.path}\``)
      }
    }
    return lines.join('\n')
  }

  /** 获取标记为 always=true 且满足要求的技能 */
  getAlwaysSkills(): string[] {
    return this.listSkills(true).filter((entry) => {
      const content = this.loadSkill(entry.name)
      return content ? extractAlwaysFlag(content) : false
    }).map((entry) => entry.name)
  }

  /** 获取技能元数据（简单版：从 frontmatter 提取） */
  getSkillMetadata(name: string): Record<string, string> | null {
    const content = this.loadSkill(name)
    if (!content || !content.startsWith('---')) return null
    const end = content.indexOf('---', 3)
    if (end === -1) return null
    const frontmatter = content.slice(3, end)
    const meta: Record<string, string> = {}
    for (const line of frontmatter.split('\n')) {
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue
      const key = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 1).trim()
      if (key && value) meta[key] = value
    }
    return meta
  }

  // ---- 内部方法 ----

  private _entriesFromDir(
    base: string,
    source: 'workspace' | 'builtin',
    skipNames?: Set<string>,
  ): SkillEntry[] {
    if (!existsSync(base)) return []
    const entries: SkillEntry[] = []
    try {
      const items = readdirSync(base, { withFileTypes: true })
      for (const item of items) {
        if (!item.isDirectory()) continue
        const skillFile = join(base, item.name, 'SKILL.md')
        if (!existsSync(skillFile)) continue
        if (skipNames?.has(item.name)) continue
        entries.push({ name: item.name, path: skillFile, source })
      }
    } catch {
      // 忽略不可读目录
    }
    return entries
  }

  private _checkRequirements(name: string): boolean {
    const content = this.loadSkill(name)
    if (!content) return false
    const requires = extractRequires(content)
    // 检查环境变量（跳过 bins 检查）
    return requires.env.every((key) => process.env[key] !== undefined)
  }

  private _getDescription(name: string): string {
    const content = this.loadSkill(name)
    if (!content) return name
    return extractFrontmatterField(content, 'description') ?? name
  }

  private _stripFrontmatter(content: string): string {
    if (!content.startsWith('---')) return content
    const end = content.indexOf('---', 3)
    if (end === -1) return content
    return content.slice(end + 3).trim()
  }
}
