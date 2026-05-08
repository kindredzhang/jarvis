import { join } from 'node:path'
export function getMediaDir(workspace?: string): string { return join(workspace ?? '/tmp', 'media') }
export function getBootstrapPaths(workspace: string): string[] {
  return ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md'].map((f) => join(workspace, f))
}
