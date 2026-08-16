/**
 * Chat-side view of a file-edit tool call. Parsers store a capped
 * `{ kind: "file-edit", … }` payload on `toolInputJson`; this module is the
 * only place the renderer should read that shape.
 */

export const TOOL_EDIT_KIND = 'file-edit' as const

export type ToolEditMode = 'replace' | 'write' | 'patch'

export type ToolEditHunk = {
  path?: string
  oldText?: string
  newText?: string
}

export type ToolEditView = {
  kind: typeof TOOL_EDIT_KIND
  path?: string
  mode: ToolEditMode
  hunks: ToolEditHunk[]
  patch?: string
  added: number
  removed: number
  truncated?: boolean
}

export type ToolEditLineKind = 'hunk' | 'add' | 'del' | 'ctx' | 'meta' | 'note'

export type ToolEditLine = {
  kind: ToolEditLineKind
  text: string
}

/** Soft cap so a Write of a generated file cannot paint thousands of nodes
 *  inside a 280px tool row. The stored `added`/`removed` still describe the
 *  whole edit. */
const LINE_CAP = 160
const LCS_CELL_CAP = 24_000

export function parseToolEdit(toolInputJson: string | undefined): ToolEditView | undefined {
  if (!toolInputJson) return undefined
  try {
    const raw: unknown = JSON.parse(toolInputJson)
    if (!isRecord(raw) || raw.kind !== TOOL_EDIT_KIND) return undefined
    const mode = raw.mode
    if (mode !== 'replace' && mode !== 'write' && mode !== 'patch') return undefined
    const hunks = Array.isArray(raw.hunks) ? raw.hunks.flatMap(parseHunk) : []
    const path = typeof raw.path === 'string' && raw.path ? raw.path : undefined
    const patch = typeof raw.patch === 'string' && raw.patch ? raw.patch : undefined
    const added = typeof raw.added === 'number' && Number.isFinite(raw.added) ? raw.added : 0
    const removed = typeof raw.removed === 'number' && Number.isFinite(raw.removed) ? raw.removed : 0
    return {
      kind: TOOL_EDIT_KIND,
      ...(path ? { path } : {}),
      mode,
      hunks,
      ...(patch ? { patch } : {}),
      added,
      removed,
      ...(raw.truncated === true ? { truncated: true } : {}),
    }
  } catch {
    return undefined
  }
}

export function toolEditMagnitude(edit: ToolEditView): string {
  const parts: string[] = []
  if (edit.added > 0) parts.push(`+${edit.added}`)
  if (edit.removed > 0) parts.push(`−${edit.removed}`)
  if (parts.length > 0) return parts.join(' ')
  return edit.mode === 'write' ? 'new file' : 'edit'
}

/**
 * The edit as a UNIFIED DIFF, for a viewer that renders one.
 *
 * The transcript is a real diff source and not a stand-in for one: `replace`
 * records the exact `oldText` the tool matched and the `newText` it wrote, and
 * `patch` carries the agent's own patch body. Rendering THAT is what shows the
 * change the run actually made — a `git diff` of the same path answers a
 * different question ("what does the worktree hold now"), which is why an edit
 * that has since been committed or superseded reads as no change at all.
 *
 * WHAT IS HONESTLY MISSING IS LINE NUMBERS. A `replace` hunk knows its text but
 * not its offset in the file, so the header goes out as a bare `@@ @@` and the
 * rows carry no numbers rather than numbers counted from a fabricated line 1.
 * A `patch` whose own `@@` headers survive keeps them, numbers and all.
 */
export function toolEditUnifiedDiff(edit: ToolEditView, cap?: number): string {
  const { lines, omitted } = toolEditLines(edit, cap)
  const out: string[] = []
  for (const line of lines) {
    switch (line.kind) {
      case 'hunk':
        // The sheet names the file in its own header and rail; a per-file label
        // only earns a row when the edit spans more than one place.
        if (lines.filter((l) => l.kind === 'hunk').length > 1) out.push(`@@ @@ ${line.text}`)
        break
      case 'meta':
        out.push(line.text.startsWith('@@') ? line.text : `@@ @@ ${line.text}`)
        break
      case 'add':
        out.push(`+${line.text}`)
        break
      case 'del':
        out.push(`-${line.text}`)
        break
      case 'note':
        out.push(`\\ ${line.text}`)
        break
      default:
        out.push(` ${line.text}`)
    }
  }
  if (omitted > 0) out.push(`\\ ${omitted} more lines not recorded in the transcript.`)
  return out.join('\n')
}

export function toolEditLines(
  edit: ToolEditView,
  cap = LINE_CAP,
): { lines: ToolEditLine[]; omitted: number } {
  const raw: ToolEditLine[] = []
  if (edit.patch) {
    raw.push(...patchLines(edit.patch))
  } else if (edit.hunks.length > 0) {
    for (const hunk of edit.hunks) {
      const label = hunk.path ?? edit.path
      if (label) raw.push({ kind: 'hunk', text: label })
      if (edit.mode === 'write' || hunk.oldText === undefined) {
        for (const line of splitLines(hunk.newText ?? '')) raw.push({ kind: 'add', text: line })
      } else {
        raw.push(...lineDiff(hunk.oldText, hunk.newText ?? ''))
      }
    }
  } else if (edit.truncated) {
    raw.push({ kind: 'note', text: 'Diff was too large to keep — open the file.' })
  }

  if (raw.length <= cap) {
    if (edit.truncated && raw[raw.length - 1]?.kind !== 'note') {
      raw.push({ kind: 'note', text: 'Diff truncated.' })
    }
    return { lines: raw, omitted: 0 }
  }
  const omitted = raw.length - cap
  return { lines: raw.slice(0, cap), omitted }
}

function parseHunk(value: unknown): ToolEditHunk[] {
  if (!isRecord(value)) return []
  const path = typeof value.path === 'string' && value.path ? value.path : undefined
  const oldText = typeof value.oldText === 'string' ? value.oldText : undefined
  const newText = typeof value.newText === 'string' ? value.newText : undefined
  if (oldText === undefined && newText === undefined) return []
  return [
    {
      ...(path ? { path } : {}),
      ...(oldText !== undefined ? { oldText } : {}),
      ...(newText !== undefined ? { newText } : {}),
    },
  ]
}

function patchLines(patch: string): ToolEditLine[] {
  const lines: ToolEditLine[] = []
  for (const line of patch.split('\n')) {
    if (
      line === '*** Begin Patch' ||
      line === '*** End Patch' ||
      line === '*** End of File'
    ) {
      continue
    }
    const file = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line)
    if (file) {
      lines.push({ kind: 'hunk', text: `${file[1]} ${file[2]}`.trim() })
      continue
    }
    if (line.startsWith('***') || line.startsWith('@@')) {
      lines.push({ kind: 'meta', text: line })
      continue
    }
    if (line.startsWith('+')) {
      lines.push({ kind: 'add', text: line.slice(1) })
      continue
    }
    if (line.startsWith('-')) {
      lines.push({ kind: 'del', text: line.slice(1) })
      continue
    }
    if (line.startsWith('\\')) {
      lines.push({ kind: 'note', text: line.replace(/^\\ ?/, '') })
      continue
    }
    lines.push({ kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line })
  }
  return lines
}

function lineDiff(oldText: string, newText: string): ToolEditLine[] {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  if (a.length === 0 && b.length === 0) return []
  if (a.length * b.length > LCS_CELL_CAP) return prefixSuffixDiff(a, b)
  return lcsDiff(a, b)
}

/** Myers-style LCS walk over two line arrays. Bounded by LCS_CELL_CAP. */
function lcsDiff(a: string[], b: string[]): ToolEditLine[] {
  const n = a.length
  const m = b.length
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    const ai = a[i]
    const row = dp[i]!
    const next = dp[i + 1]!
    for (let j = m - 1; j >= 0; j--) {
      row[j] = ai === b[j] ? (next[j + 1]! + 1) as number : Math.max(next[j]!, row[j + 1]!)
    }
  }
  const lines: ToolEditLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'ctx', text: a[i]! })
      i += 1
      j += 1
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      lines.push({ kind: 'del', text: a[i]! })
      i += 1
    } else {
      lines.push({ kind: 'add', text: b[j]! })
      j += 1
    }
  }
  while (i < n) {
    lines.push({ kind: 'del', text: a[i]! })
    i += 1
  }
  while (j < m) {
    lines.push({ kind: 'add', text: b[j]! })
    j += 1
  }
  return lines
}

function prefixSuffixDiff(a: string[], b: string[]): ToolEditLine[] {
  let start = 0
  const maxStart = Math.min(a.length, b.length)
  while (start < maxStart && a[start] === b[start]) start += 1
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1
    endB -= 1
  }
  const lines: ToolEditLine[] = []
  for (let i = 0; i < start; i++) lines.push({ kind: 'ctx', text: a[i]! })
  for (let i = start; i <= endA; i++) lines.push({ kind: 'del', text: a[i]! })
  for (let j = start; j <= endB; j++) lines.push({ kind: 'add', text: b[j]! })
  for (let i = endA + 1; i < a.length; i++) lines.push({ kind: 'ctx', text: a[i]! })
  return lines
}

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
