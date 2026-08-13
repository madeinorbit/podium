/**
 * Normalize a file-editing tool call into a capped JSON payload the chat can
 * unfold as a diff. Each harness writes a different wire shape (Claude's
 * old_string/new_string, Codex apply_patch, Grok search_replace, …); this is
 * the one form the renderer reads.
 *
 * Stored on TranscriptItem.toolInputJson with `kind: "file-edit"` so it cannot
 * be mistaken for an AskUserQuestion card. Ordinary tools stay without
 * toolInputJson — a Write of a generated 40k-line file must not bloat the
 * transcript buffer.
 */

export const TOOL_EDIT_KIND = 'file-edit' as const

export type ToolEditMode = 'replace' | 'write' | 'patch'

export type ToolEditHunk = {
  path?: string
  oldText?: string
  newText?: string
}

export type ToolEditPayload = {
  kind: typeof TOOL_EDIT_KIND
  path?: string
  mode: ToolEditMode
  hunks: ToolEditHunk[]
  /** Raw apply_patch body when we kept the original patch text. */
  patch?: string
  added: number
  removed: number
  truncated?: boolean
}

/** How much JSON one file-edit may spend on the item. Same order of magnitude
 *  as AskUserQuestion — enough for a real hunk, not a whole generated file. */
const EDIT_INPUT_MAX = 24_000
const HUNK_TEXT_BUDGETS = [8_000, 2_400, 800, 240, 0] as const

const FILE_PATH_KEYS = [
  'file_path',
  'target_file',
  'path',
  'notebook_path',
  'filePath',
  'targetFile',
  'notebookPath',
] as const

const OLD_KEYS = ['old_string', 'oldString', 'old_str', 'old_source', 'oldSource', 'old_text'] as const
const NEW_KEYS = [
  'new_string',
  'newString',
  'new_str',
  'new_source',
  'newSource',
  'new_text',
  'contents',
  'content',
] as const

const WRITE_NEW_KEYS = ['contents', 'content', 'new_string', 'newString', 'new_source'] as const

const FILE_EDIT_NAMES = new Set([
  'edit',
  'write',
  'multiedit',
  'notebookedit',
  'searchreplace',
  'strreplace',
  'applypatch',
  'createfile',
  'writefile',
  'replace',
])

export function isFileEditToolName(name: string): boolean {
  return FILE_EDIT_NAMES.has(normalizeToolName(name))
}

export function looksLikePatch(text: string): boolean {
  return (
    text.includes('*** Begin Patch') ||
    text.includes('*** Update File:') ||
    text.includes('*** Add File:') ||
    text.includes('*** Delete File:')
  )
}

/** Extract a file-edit payload from a harness tool name + raw input. Returns
 *  undefined when the call is not an edit (or has no recoverable change). */
export function extractToolEdit(toolName: string, input: unknown): ToolEditPayload | undefined {
  if (typeof input === 'string') {
    if (looksLikePatch(input)) return extractToolEditFromPatch(input)
    if (isWriteName(toolName) && input.trim()) {
      return finishEdit({
        kind: TOOL_EDIT_KIND,
        mode: 'write',
        hunks: [{ newText: input }],
      })
    }
    return undefined
  }
  if (!isRecord(input)) return undefined

  const patch = stringFrom(input, ['patch', 'diff'])
  if (patch && looksLikePatch(patch)) return extractToolEditFromPatch(patch)

  const path = stringFrom(input, FILE_PATH_KEYS)
  const edits = input.edits
  if (Array.isArray(edits) && edits.length > 0) {
    const hunks: ToolEditHunk[] = []
    for (const entry of edits) {
      if (!isRecord(entry)) continue
      const oldText = stringFrom(entry, OLD_KEYS)
      const newText = stringFrom(entry, NEW_KEYS)
      if (oldText === undefined && newText === undefined) continue
      hunks.push({
        ...(path ? { path } : {}),
        ...(oldText !== undefined ? { oldText } : {}),
        ...(newText !== undefined ? { newText } : {}),
      })
    }
    if (hunks.length === 0) return undefined
    return finishEdit({
      kind: TOOL_EDIT_KIND,
      ...(path ? { path } : {}),
      mode: 'replace',
      hunks,
    })
  }

  const oldText = stringFrom(input, OLD_KEYS)
  if (oldText !== undefined) {
    const newText = stringFrom(input, NEW_KEYS) ?? ''
    return finishEdit({
      kind: TOOL_EDIT_KIND,
      ...(path ? { path } : {}),
      mode: 'replace',
      hunks: [
        {
          ...(path ? { path } : {}),
          oldText,
          newText,
        },
      ],
    })
  }

  if (isWriteName(toolName) || isFileEditToolName(toolName)) {
    const contents = stringFrom(input, WRITE_NEW_KEYS)
    if (contents !== undefined) {
      return finishEdit({
        kind: TOOL_EDIT_KIND,
        ...(path ? { path } : {}),
        mode: isWriteName(toolName) || oldText === undefined ? 'write' : 'replace',
        hunks: [
          {
            ...(path ? { path } : {}),
            newText: contents,
          },
        ],
      })
    }
  }

  return undefined
}

/** Codex `apply_patch` body → the same payload. */
export function extractToolEditFromPatch(patch: string): ToolEditPayload | undefined {
  const trimmed = patch.trim()
  if (!trimmed) return undefined
  const paths = [...trimmed.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].flatMap(
    (match) => (match[1] ? [match[1].trim()] : []),
  )
  const createsOnly =
    /\*\*\* Add File:/.test(trimmed) && !/\*\*\* (?:Update|Delete) File:/.test(trimmed)
  const { added, removed } = countPatchLines(trimmed)
  return {
    kind: TOOL_EDIT_KIND,
    ...(paths[0] ? { path: paths[0] } : {}),
    mode: createsOnly ? 'write' : 'patch',
    hunks: [],
    patch: trimmed,
    added,
    removed,
  }
}

export function safeToolEditJson(edit: ToolEditPayload): string | undefined {
  try {
    const raw = JSON.stringify(edit)
    if (raw === undefined) return undefined
    if (raw.length <= EDIT_INPUT_MAX) return raw
  } catch {
    return undefined
  }
  for (const budget of HUNK_TEXT_BUDGETS) {
    try {
      const next = shrinkEdit(edit, budget)
      const raw = JSON.stringify(next)
      if (raw !== undefined && raw.length <= EDIT_INPUT_MAX) return raw
    } catch {
      return undefined
    }
  }
  try {
    const fallback = JSON.stringify({
      kind: TOOL_EDIT_KIND,
      ...(edit.path ? { path: edit.path } : {}),
      mode: edit.mode,
      hunks: [],
      added: edit.added,
      removed: edit.removed,
      truncated: true,
    } satisfies ToolEditPayload)
    return fallback !== undefined && fallback.length <= EDIT_INPUT_MAX ? fallback : undefined
  } catch {
    return undefined
  }
}

export function safeToolEditJsonFromInput(toolName: string, input: unknown): string | undefined {
  const edit = extractToolEdit(toolName, input)
  return edit ? safeToolEditJson(edit) : undefined
}

function finishEdit(
  edit: Omit<ToolEditPayload, 'added' | 'removed'> & { added?: number; removed?: number },
): ToolEditPayload {
  const { added, removed } =
    edit.added !== undefined && edit.removed !== undefined
      ? { added: edit.added, removed: edit.removed }
      : countHunks(edit.hunks)
  return { ...edit, added, removed }
}

function countHunks(hunks: ToolEditHunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    added += lineCount(hunk.newText)
    removed += lineCount(hunk.oldText)
  }
  return { added, removed }
}

function countPatchLines(patch: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('***')) continue
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }
  return { added, removed }
}

function lineCount(text: string | undefined): number {
  if (text === undefined || text === '') return 0
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return Math.max(1, lines.length)
}

function shrinkEdit(edit: ToolEditPayload, budget: number): ToolEditPayload {
  const cut = (text: string | undefined): string | undefined => {
    if (text === undefined) return undefined
    if (budget === 0) return undefined
    if (text.length <= budget) return text
    return `${text.slice(0, budget)}\n…`
  }
  return {
    ...edit,
    truncated: true,
    ...(edit.patch !== undefined
      ? budget === 0
        ? { patch: undefined }
        : { patch: cut(edit.patch) }
      : {}),
    hunks: edit.hunks.map((hunk) => ({
      ...(hunk.path ? { path: hunk.path } : {}),
      ...(cut(hunk.oldText) !== undefined ? { oldText: cut(hunk.oldText) } : {}),
      ...(cut(hunk.newText) !== undefined ? { newText: cut(hunk.newText) } : {}),
    })),
  }
}

function isWriteName(name: string): boolean {
  const n = normalizeToolName(name)
  return n === 'write' || n === 'createfile' || n === 'writefile'
}

function normalizeToolName(name: string): string {
  const bare = name.includes('__') ? (name.split('__').pop() ?? name) : name
  return bare.toLowerCase().replace(/[_-]/g, '')
}

function stringFrom(rec: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = rec[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
