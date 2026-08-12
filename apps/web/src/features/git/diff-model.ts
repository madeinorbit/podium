/**
 * Unified diff → render-ready rows for the diff sheet.
 *
 * The dock panel printed a diff as coloured TEXT: every line was one string,
 * the sign was the first character, and the reader counted braces to find out
 * where in the file they were. A viewer that gets a whole sheet can afford the
 * structure git already encodes — which line of the OLD file, which line of the
 * NEW one, and which hunk they belong to — so the parse resolves that here and
 * the component only paints it.
 *
 * File-level preamble (`diff --git`, `index`, `---`, `+++`, mode and rename
 * lines) is dropped: the sheet names the file, its status and its counts in its
 * own header, and repeating them as the first four lines of every diff is the
 * git CLI's constraint, not ours. `Binary files … differ` survives as a note,
 * because there the message IS the whole answer.
 */

/** Rows are what the sheet paints, one per line of the rendered diff. */
export type DiffRowKind = 'hunk' | 'add' | 'del' | 'ctx' | 'note'

export type DiffRow = {
  kind: DiffRowKind
  /** Line content WITHOUT its +/- marker; the `@@ … @@` span for a hunk. */
  text: string
  /** Hunk only: git's trailing context (the enclosing function, usually). */
  context?: string
  /** 1-based line number in the pre-image, absent on added lines. */
  oldNo?: number
  /** 1-based line number in the post-image, absent on removed lines. */
  newNo?: number
}

export type ParsedDiff = {
  rows: DiffRow[]
  added: number
  removed: number
  /** Git had no textual diff to give (a binary blob). */
  binary: boolean
  /** Lines past the render cap: counted, dropped from `rows`, and stated. */
  truncated: number
}

/**
 * A diff longer than this renders as its first `DIFF_ROW_CAP` rows plus a
 * stated remainder. Four spans per row means a 40k-line generated-file diff
 * would put 160k nodes in a modal — and nobody reads a 40k-line diff in one;
 * they open the file. The cap is announced in the footer, never silent.
 */
export const DIFF_ROW_CAP = 2500

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

/** `@@ -12,7 +12,9 @@ function foo() {` → both starts plus the context tail. */
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/

export function parseDiff(text: string, cap: number = DIFF_ROW_CAP): ParsedDiff {
  const rows: DiffRow[] = []
  let added = 0
  let removed = 0
  let binary = false
  let truncated = 0
  let oldNo = 0
  let newNo = 0

  // The counters keep running past the cap so the header's totals describe the
  // whole diff, not the part that fit.
  const push = (row: DiffRow): void => {
    if (rows.length >= cap) {
      truncated += 1
      return
    }
    rows.push(row)
  }

  const lines = text.split('\n')
  // A trailing newline is a terminator, not an empty last line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  for (const line of lines) {
    if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
      binary = true
      push({ kind: 'note', text: line })
      continue
    }
    if (PREAMBLE.some((p) => line.startsWith(p))) continue
    const hunk = HUNK.exec(line)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      const context = hunk[3] ?? ''
      push({
        kind: 'hunk',
        text: line.slice(0, line.indexOf('@@', 2) + 2),
        ...(context === '' ? {} : { context }),
      })
      continue
    }
    if (line.startsWith('\\')) {
      // `\ No newline at end of file` — about the line above, not a line itself.
      push({ kind: 'note', text: line.replace(/^\\ /, '') })
      continue
    }
    if (line.startsWith('+')) {
      added += 1
      push({ kind: 'add', text: line.slice(1), newNo })
      newNo += 1
      continue
    }
    if (line.startsWith('-')) {
      removed += 1
      push({ kind: 'del', text: line.slice(1), oldNo })
      oldNo += 1
      continue
    }
    // Context lines carry a leading space; git omits it on a truly empty line.
    push({ kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line, oldNo, newNo })
    oldNo += 1
    newNo += 1
  }

  return { rows, added, removed, binary, truncated }
}

/**
 * Split a repo-relative path into its directory and its file name. Git reports
 * an untracked FOLDER as one entry with a trailing slash (`.artifacts/POD-1/`);
 * the slash stays on the name, where it is the thing that says "folder", rather
 * than swallowing the name into the directory and leaving the row blank.
 */
export function splitPath(path: string): { dir: string; name: string } {
  const folder = path.endsWith('/')
  const body = folder ? path.slice(0, -1) : path
  const cut = body.lastIndexOf('/')
  const name = (cut < 0 ? body : body.slice(cut + 1)) + (folder ? '/' : '')
  return { dir: cut < 0 ? '' : body.slice(0, cut), name }
}
