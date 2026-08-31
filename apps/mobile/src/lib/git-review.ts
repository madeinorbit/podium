/** Render-ready Git status and unified-diff parsing for the phone review block.
 * The inputs are the existing fixed, read-only repo operations. */

export interface StatusEntry {
  x: string
  y: string
  path: string
  renamedFrom?: string
  untracked: boolean
}

export interface StatusHeader {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
}

function unquotePath(path: string): string {
  if (!(path.startsWith('"') && path.endsWith('"') && path.length >= 2)) return path
  return path
    .slice(1, -1)
    .replace(/\\([\\"tn])/g, (_, char: string) =>
      char === 't' ? '\t' : char === 'n' ? '\n' : char,
    )
}

export function parseStatus(output: string): { header: StatusHeader; entries: StatusEntry[] } {
  const header: StatusHeader = { branch: null, upstream: null, ahead: 0, behind: 0 }
  const entries: StatusEntry[] = []
  for (const line of output.split('\n')) {
    if (!line) continue
    if (line.startsWith('## ')) {
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
      const match = body.match(/^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/)
      if (match) {
        header.branch = match[1] ?? null
        header.upstream = match[2] ?? null
        const counters = match[3] ?? ''
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
  entries.sort((left, right) =>
    left.untracked !== right.untracked
      ? left.untracked
        ? 1
        : -1
      : left.path.localeCompare(right.path),
  )
  return { header, entries }
}

function statusWord(code: string): string {
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
      return 'changed'
  }
}

export function entryBadge(entry: StatusEntry): string {
  return entry.untracked ? '??' : `${entry.x}${entry.y}`.trim()
}

export function entryStatus(entry: StatusEntry): string {
  if (entry.untracked) return 'untracked'
  const parts: string[] = []
  if (entry.x !== ' ') parts.push(`${statusWord(entry.x)} (staged)`)
  if (entry.y !== ' ') parts.push(statusWord(entry.y))
  return parts.join(' + ') || 'changed'
}

export function untrackedDiff(content: string): string {
  const body = content.endsWith('\n') ? content.slice(0, -1) : content
  if (!body && !content) return ''
  const lines = body.split('\n')
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join('\n')
}

export type DiffRowKind = 'hunk' | 'add' | 'del' | 'ctx' | 'note'

export interface DiffRow {
  kind: DiffRowKind
  text: string
  context?: string
}

export interface ParsedDiff {
  rows: DiffRow[]
  added: number
  removed: number
  binary: boolean
  truncated: number
}

const PREAMBLE = [
  'diff ',
  'index ',
  '--- ',
  '+++ ',
  'old mode ',
  'new mode ',
  'new file mode ',
  'deleted file mode ',
  'similarity index ',
  'dissimilarity index ',
  'rename from ',
  'rename to ',
  'copy from ',
  'copy to ',
]
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/

/** Phone reviews cap each open file at 600 visible rows. The omitted count is
 * always stated, so a generated file cannot freeze a short review session. */
export function parseDiff(text: string, cap = 600): ParsedDiff {
  const rows: DiffRow[] = []
  let added = 0
  let removed = 0
  let binary = false
  let truncated = 0
  const push = (row: DiffRow): void => {
    if (rows.length >= cap) truncated += 1
    else rows.push(row)
  }
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  for (const line of lines) {
    if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
      binary = true
      push({ kind: 'note', text: line })
      continue
    }
    if (PREAMBLE.some((prefix) => line.startsWith(prefix))) continue
    const hunk = HUNK.exec(line)
    if (hunk) {
      const context = hunk[3] ?? ''
      push({
        kind: 'hunk',
        text: line.slice(0, line.indexOf('@@', 2) + 2),
        ...(context ? { context } : {}),
      })
      continue
    }
    if (line.startsWith('\\')) {
      push({ kind: 'note', text: line.replace(/^\\ /, '') })
      continue
    }
    if (line.startsWith('+')) {
      added += 1
      push({ kind: 'add', text: line.slice(1) })
      continue
    }
    if (line.startsWith('-')) {
      removed += 1
      push({ kind: 'del', text: line.slice(1) })
      continue
    }
    push({ kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line })
  }
  return { rows, added, removed, binary, truncated }
}
