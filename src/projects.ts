import type { ThreadSummary } from './types'

export interface ProjectGroup { key: string; cwd: string; sessions: ThreadSummary[]; updatedAt: number }

export function normalizeProjectPath(cwd: string) {
  let value = cwd.trim().replace(/\\/g, '/').replace(/\/$/, '')
  const windows = value.match(/^([a-zA-Z]):\/(.*)$/)
  if (windows) value = `/mnt/${windows[1].toLowerCase()}/${windows[2]}`
  return value.toLowerCase()
}

export function groupThreadsByProject(threads: ThreadSummary[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>()
  for (const thread of [...threads].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const key = normalizeProjectPath(thread.cwd || '未指定路径')
    const group = groups.get(key) || { key, cwd: thread.cwd || '未指定路径', sessions: [], updatedAt: thread.updatedAt }
    group.sessions.push(thread)
    group.updatedAt = Math.max(group.updatedAt, thread.updatedAt)
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}
