import { homedir } from 'node:os'
import { join } from 'node:path'

export interface CursorSessionPaths {
  chatId: string
  projectSlug: string
  transcriptPath: string
}

/** Cursor's per-project dir name: cwd without leading `/`, `/` → `-`, lowercased. */
export function cursorProjectSlug(cwd: string): string {
  return cwd.replace(/^\//, '').replace(/\//g, '-').toLowerCase()
}

/** Best-effort decode of a Cursor project slug back to an absolute path. */
export function cursorProjectPathFromSlug(slug: string): string | undefined {
  const trimmed = slug.trim()
  if (!trimmed) return undefined
  return `/${trimmed.replace(/-/g, '/')}`
}

export function cursorRoot(homeDir?: string): string {
  return join(homeDir ?? homedir(), '.cursor')
}

export function cursorSessionPaths(opts: {
  cwd: string
  chatId: string
  homeDir?: string
}): CursorSessionPaths {
  const projectSlug = cursorProjectSlug(opts.cwd)
  const transcriptDir = join(
    cursorRoot(opts.homeDir),
    'projects',
    projectSlug,
    'agent-transcripts',
    opts.chatId,
  )
  return {
    chatId: opts.chatId,
    projectSlug,
    transcriptPath: join(transcriptDir, `${opts.chatId}.jsonl`),
  }
}