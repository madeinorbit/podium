/**
 * Pure parsing for the Git dock panel [POD-114]: raw output of the read-only
 * repo ops (statusProbe / logPanel / diffFile / commitFiles) → render-ready
 * rows. Rendering lives in GitPanelView.tsx.
 */

/** One changed file — from `git status --porcelain=v1 -b` for the working tree,
 *  or from a commit's own file list (see `committed`). */
export type StatusEntry = {
  /** Staged (index) status letter, ' ' when unstaged-only. */
  x: string
  /** Unstaged (worktree) status letter, ' ' when fully staged. */
  y: string
  path: string
  /** Rename/copy source (`R  old -> new`). */
  renamedFrom?: string
  untracked: boolean
  /**
   * This file is a line of a COMMIT, not of the working tree [POD-1289]. The
   * panel and the sheet render both through the same row — same badge, same
   * name, same diff pane — so the shape is shared; what the flag changes is the
   * VOCABULARY. Inside a commit there is no staged/unstaged split to report,
   * and the badge must not borrow the colour that means "staged": everything in
   * a commit is committed, which is one state, not two.
   */
  committed?: boolean
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
    .replace(/\\([\\"tn])/g, (_, c: string) => (c === 't' ? '\t' : c === 'n' ? '\n' : c))
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

/**
 * Parse `git show --format= --name-status -M` (the commitFiles op) into the same
 * rows the working tree uses. Lines are `M\tpath` — or `R100\told\tnew` for a
 * detected rename, where the digits are git's similarity score and carry nothing
 * the reader of a file list needs.
 */
export function parseCommitFiles(output: string): StatusEntry[] {
  const entries: StatusEntry[] = []
  for (const line of output.split('\n')) {
    if (line === '') continue
    const parts = line.split('\t')
    const code = parts[0]
    if (!code || parts.length < 2) continue
    const letter = code[0] ?? 'M'
    // A rename/copy names both ends; everything else names one path.
    const isPair = (letter === 'R' || letter === 'C') && parts.length >= 3
    const path = unquotePath((isPair ? parts[2] : parts[1]) ?? '')
    if (path === '') continue
    const entry: StatusEntry = { x: letter, y: ' ', path, untracked: false, committed: true }
    if (isPair) entry.renamedFrom = unquotePath(parts[1] ?? '')
    entries.push(entry)
  }
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return entries
}

/**
 * Synthesize an all-added diff for an untracked file (git diff HEAD skips it).
 * The hunk header is part of the synthesis, not decoration: it is what lets an
 * untracked file render through the same parser — and be line-numbered — as a
 * tracked one, instead of needing a second path in the viewer.
 */
export function untrackedDiff(content: string): string {
  const body = content.endsWith('\n') ? content.slice(0, -1) : content
  if (body === '' && content === '') return ''
  const lines = body.split('\n')
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n')
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
  if (e.committed) return e.x
  if (e.untracked) return '??'
  return `${e.x}${e.y}`.trim()
}

/** What happened to the file, in words: "modified (staged) + modified". */
export function entryStatus(e: StatusEntry): string {
  // A commit has one axis. `M` there means "this commit modified it", full stop
  // — reporting it as "modified (staged)" would name an index that no longer
  // has anything to say about a file already in history.
  if (e.committed) return statusWord(e.x) || 'changed'
  if (e.untracked) return 'untracked'
  const parts: string[] = []
  if (e.x !== ' ') parts.push(`${statusWord(e.x)} (staged)`)
  if (e.y !== ' ') parts.push(statusWord(e.y))
  return parts.join(' + ')
}

/** Hover title: "modified (staged) — src/a.ts". */
export function entryTitle(e: StatusEntry): string {
  const from = e.renamedFrom ? ` (from ${e.renamedFrom})` : ''
  return `${entryStatus(e)} — ${e.path}${from}`
}

/**
 * Which axis an entry lives on. Both surfaces tint the badge by it — the dock
 * in utilities, the sheet in its own stylesheet — so the RULE (staged reads
 * live, unstaged reads warning, untracked stays muted, a commit's files stay
 * dim because "committed" is one state and needs no signal colour) is decided once here
 * rather than restated in two class lists that can drift apart.
 */
export function entryTone(e: StatusEntry): 'staged' | 'unstaged' | 'untracked' | 'committed' {
  if (e.committed) return 'committed'
  if (e.untracked) return 'untracked'
  if (e.x !== ' ' && e.y === ' ') return 'staged'
  return 'unstaged'
}
