import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { SkillsLoader } from './skills'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'jarvis-skills-test-'))
})

afterEach(() => {
  try {
    rmSync(workspace, { recursive: true, force: true })
  } catch {
    // ignore cleanup errors
  }
})

describe('SkillsLoader', () => {
  test('listSkills is empty when no skills exist', () => {
    const loader = new SkillsLoader({ workspace })
    const skills = loader.listSkills()
    expect(skills).toHaveLength(0)
  })

  test('finds workspace skills', () => {
    const skillsDir = join(workspace, 'skills')
    mkdirSync(skillsDir, { recursive: true })
    mkdirSync(join(skillsDir, 'test-skill'))
    writeFileSync(
      join(skillsDir, 'test-skill', 'SKILL.md'),
      '---\nname: test-skill\ndescription: A test skill\n---\n\n# Test Skill\n\nDo something.',
      'utf-8',
    )

    const loader = new SkillsLoader({ workspace })
    const skills = loader.listSkills()
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('test-skill')
    expect(skills[0].source).toBe('workspace')
  })

  test('loadSkill returns null for unknown skill', () => {
    const loader = new SkillsLoader({ workspace })
    expect(loader.loadSkill('nonexistent')).toBeNull()
  })

  test('loadSkill reads skill content', () => {
    const skillsDir = join(workspace, 'skills')
    mkdirSync(skillsDir, { recursive: true })
    mkdirSync(join(skillsDir, 'greeter'))
    writeFileSync(
      join(skillsDir, 'greeter', 'SKILL.md'),
      '---\nname: greeter\ndescription: Greets users\n---\n\nHello!',
      'utf-8',
    )

    const loader = new SkillsLoader({ workspace })
    const content = loader.loadSkill('greeter')
    expect(content).toContain('Hello!')
  })

  test('getAlwaysSkills returns only always=true skills', () => {
    const skillsDir = join(workspace, 'skills')
    mkdirSync(skillsDir, { recursive: true })

    mkdirSync(join(skillsDir, 'always-skill'))
    writeFileSync(
      join(skillsDir, 'always-skill', 'SKILL.md'),
      '---\nname: always-skill\ndescription: Always loaded\nalways: true\n---\n\nImportant!',
      'utf-8',
    )

    mkdirSync(join(skillsDir, 'normal-skill'))
    writeFileSync(
      join(skillsDir, 'normal-skill', 'SKILL.md'),
      '---\nname: normal-skill\ndescription: Normal\n---\n\nNormal.',
      'utf-8',
    )

    const loader = new SkillsLoader({ workspace })
    const always = loader.getAlwaysSkills()
    expect(always).toContain('always-skill')
    expect(always).not.toContain('normal-skill')
  })

  test('respects disabledSkills', () => {
    const skillsDir = join(workspace, 'skills')
    mkdirSync(skillsDir, { recursive: true })
    mkdirSync(join(skillsDir, 'blocked'))
    writeFileSync(join(skillsDir, 'blocked', 'SKILL.md'), '---\n---\n\nBlocked.', 'utf-8')

    const loader = new SkillsLoader({ workspace, disabledSkills: ['blocked'] })
    const skills = loader.listSkills()
    expect(skills).toHaveLength(0)
  })

  test('buildSkillsSummary formats properly', () => {
    const skillsDir = join(workspace, 'skills')
    mkdirSync(skillsDir, { recursive: true })
    mkdirSync(join(skillsDir, 'finder'))
    writeFileSync(
      join(skillsDir, 'finder', 'SKILL.md'),
      '---\nname: finder\ndescription: Find things\n---\n\nSearch tool.',
      'utf-8',
    )

    const loader = new SkillsLoader({ workspace })
    const summary = loader.buildSkillsSummary()
    expect(summary).toContain('finder')
    expect(summary).toContain('Find things')
  })

  test('buildSkillsSummary excludes specified skills', () => {
    const skillsDir = join(workspace, 'skills')
    mkdirSync(skillsDir, { recursive: true })
    mkdirSync(join(skillsDir, 'skill-a'))
    writeFileSync(join(skillsDir, 'skill-a', 'SKILL.md'), '---\n---\n\nA.', 'utf-8')
    mkdirSync(join(skillsDir, 'skill-b'))
    writeFileSync(join(skillsDir, 'skill-b', 'SKILL.md'), '---\n---\n\nB.', 'utf-8')

    const loader = new SkillsLoader({ workspace })
    const summary = loader.buildSkillsSummary(new Set(['skill-a']))
    expect(summary).toContain('skill-b')
    expect(summary).not.toContain('skill-a')
  })

  test('getSkillMetadata extracts frontmatter', () => {
    const skillsDir = join(workspace, 'skills')
    mkdirSync(skillsDir, { recursive: true })
    mkdirSync(join(skillsDir, 'meta-skill'))
    writeFileSync(
      join(skillsDir, 'meta-skill', 'SKILL.md'),
      '---\nname: meta-skill\ndescription: Meta\ncustom: value\n---\n\nBody.',
      'utf-8',
    )

    const loader = new SkillsLoader({ workspace })
    const meta = loader.getSkillMetadata('meta-skill')
    expect(meta).not.toBeNull()
    expect(meta!.description).toBe('Meta')
    expect(meta!.custom).toBe('value')
  })
})
