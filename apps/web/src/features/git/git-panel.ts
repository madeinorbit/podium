/**
 * Pure parsing for the Git dock panel [POD-114]: raw output of the read-only
 * repo ops (statusProbe / logPanel / diffFile) → render-ready rows. Rendering
 * lives in GitPanelView.tsx.
 */

/** One working-tree entry from `git status --porcelain=v1 -b`. */
export type StatusEntry = {
  /** Staged (index) status letter, ' ' when unstaged-only. */
  x: string
  /** Unstaged (worktree) status letter, ' ' when fully staged. */
  y: string
  path: string
  /** Rename/copy source (`R  old -> new`). */
  renamedFrom?: string
  untracked: boolean
}

export type StatusHeader = {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
}

/** Strip the C-style quoting git applies to paths with special characters. */
function unquotePath(p: string): string {
  if (!(p.startsWith('"') && p.endsWith('"') && p.length >= 2)) return p
  return p
    .slice(1, -1)
    .replace(/\\([\\"tn])/g, (_, c: string) =>
      c === 't' ? '\t' : c === 'n' ? '\n' : c,
    )
}

/** Parse `git status --porcelain=v1 -b` output (the statusProbe op). */
export function parseStatus(output: string): { header: StatusHeader; entries: StatusEntry[] } {
  const header: StatusHeader = { branch: null, upstream: null, ahead: 0, behind: 0 }
  const entries: StatusEntry[] = []
  for (const line of output.split('\n')) {
    if (line === '') continue
    if (line.startsWith('## ')) {
      // `## main...origin/main [ahead 1, behind 2]` | `## main` |
      // `## HEAD (no branch)` | `## No commits yet on main`
      const body = line.slice(3)
      const noCommits = body.match(/^No commits yet on (.+)$/)
      if (noCommits) {
        header.branch = noCommits[1] ?? null
        continue
      }
      if (body.startsWith('HEAD (')) {
        header.branch = 'HEAD (detached)'
        continue
      }
      const m = body.match(/^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/)
      if (m) {
        header.branch = m[1] ?? null
        header.upstream = m[2] ?? null
        const counters = m[3] ?? ''
        header.ahead = Number(counters.match(/ahead (\d+)/)?.[1] ?? 0)
        header.behind = Number(counters.match(/behind (\d+)/)?.[1] ?? 0)
      }
      continue
    }
    if (line.length < 4) continue
    const x = line[0] ?? ' '
    const y = line[1] ?? ' '
    const rest = line.slice(3)
    const arrow = x === 'R' || x === 'C' ? rest.indexOf(' -> ') : -1
    const entry: StatusEntry = {
      x,
      y,
      path: unquotePath(arrow >= 0 ? rest.slice(arrow + 4) : rest),
      untracked: x === '?' && y === '?',
    }
    if (arrow >= 0) entry.renamedFrom = unquotePath(rest.slice(0, arrow))
    entries.push(entry)
  }
  // Tracked changes first, untracked last; stable path order inside each group.
  entries.sort((a, b) =>
    a.untracked !== b.untracked ? (a.untracked ? 1 : -1) : a.path.localeCompare(b.path),
  )
  return { header, entries }
}

/** One commit from the logPanel op (`%h\t%H\t%cI\t%an\t%s`). */
export type LogEntry = {
  shortSha: string
  sha: string
  /** ISO committer date. */
  date: string
  author: string
  subject: string
}

export function parseLog(output: string): LogEntry[] {
  const entries: LogEntry[] = []
  for (const line of output.split('\n')) {
    if (line === '') continue
    // Subject rides last and may itself contain tabs — split the first four only.
    const parts = line.split('\t')
    if (parts.length < 5) continue
    const [shortSha, sha, date, author] = parts as [string, string, string, string, ...string[]]
    entries.push({ shortSha, sha, date, author, subject: parts.slice(4).join('\t') })
  }
  return entries
}

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx'

/** Classify one unified-diff line for coloring. */
export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  if (line.startsWith('@@')) return 'hunk'
  if (
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('rename ') ||
    line.startsWith('similarity ') ||
    line.startsWith('Binary files') ||
    line.startsWith('\\ No newline')
  )
    return 'meta'
  return 'ctx'
}

/** Synthesize an all-added diff for an untracked file (git diff HEAD skips it). */
export function untrackedDiff(content: string): string {
  const body = content.endsWith('\n') ? content.slice(0, -1) : content
  if (body === '' && content === '') return ''
  return body
    .split('\n')
    .map((l) => `+${l}`)
    .join('\n')
}

/** Human word for a porcelain status letter (hover titles). */
export function statusWord(code: string): string {
  switch (code) {
    case 'M':
      return 'modified'
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'U':
      return 'conflicted'
    case 'T':
      return 'type changed'
    case '?':
      return 'untracked'
    default:
      return ''
  }
}

/** Two-letter badge for an entry — `??` for untracked, else trimmed XY. */
export function entryBadge(e: StatusEntry): string {
  if (e.untracked) return '??'
  return `${e.x}${e.y}`.trim()
}

/** Hover title: "modified (staged) — src/a.ts". */
export function entryTitle(e: StatusEntry): string {
  if (e.untracked) return `untracked — ${e.path}`
  const parts: string[] = []
  if (e.x !== ' ') parts.push(`${statusWord(e.x)} (staged)`)
  if (e.y !== ' ') parts.push(statusWord(e.y))
  const from = e.renamedFrom ? ` (from ${e.renamedFrom})` : ''
  return `${parts.join(' + ')} — ${e.path}${from}`
}
