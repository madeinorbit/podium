import { safeToolEditJson, type ToolEditPayload } from './tool-edit'

/** Effects belong to the result record; joining them to intent is a view concern. */
export type ToolEffect =
  | { kind: 'file-edit'; edit: ToolEditPayload; userModified?: boolean }
  | { kind: 'git-operation'; operation: string }
  | { kind: 'background-task'; taskId: string }
  | {
      kind: 'termination'
      interrupted?: boolean
      timedOutAfterMs?: number
      interpretation?: string
    }
  | { kind: 'stderr'; text: string }

export function claudeToolEffects(value: unknown): ToolEffect[] {
  if (!isRecord(value)) return []
  const effects: ToolEffect[] = []
  const bash = isRecord(value.bashEditDiff) ? value.bashEditDiff : undefined
  const files = bash && Array.isArray(bash.files) ? bash.files.filter(isRecord) : []
  if (files.length || Array.isArray(value.structuredPatch)) {
    const patchFiles = files.length
      ? files
      : [{ filePath: value.filePath, hunks: value.structuredPatch }]
    let added = 0
    let removed = 0
    const sections: string[] = []
    for (const file of patchFiles) {
      const lines = [
        `--- ${string(file.filePath) ?? '(unknown file)'}`,
        `+++ ${string(file.filePath) ?? '(unknown file)'}`,
      ]
      for (const hunk of Array.isArray(file.hunks) ? file.hunks : []) {
        if (!isRecord(hunk) || !Array.isArray(hunk.lines)) continue
        lines.push(
          `@@ -${number(hunk.oldStart)},${number(hunk.oldLines)} +${number(hunk.newStart)},${number(hunk.newLines)} @@`,
        )
        for (const line of hunk.lines) {
          if (typeof line !== 'string') continue
          if (line.startsWith('+')) added++
          if (line.startsWith('-')) removed++
          lines.push(line)
        }
      }
      sections.push(lines.join('\n'))
    }
    const created = !files.length && value.type === 'create' && typeof value.content === 'string'
    if (created)
      added = value.content === '' ? 0 : value.content.replace(/\n$/, '').split('\n').length
    const edit: ToolEditPayload = {
      kind: 'file-edit',
      ...(typeof patchFiles[0]?.filePath === 'string' ? { path: patchFiles[0].filePath } : {}),
      mode: created ? 'write' : 'patch',
      hunks: created ? [{ newText: value.content as string }] : [],
      ...(!created ? { patch: sections.join('\n') } : {}),
      added,
      removed,
      changedFiles: typeof bash?.changedFiles === 'number' ? bash.changedFiles : patchFiles.length,
      ...(typeof bash?.moreFiles === 'number' ? { moreFiles: bash.moreFiles } : {}),
    }
    const json = safeToolEditJson(edit)
    if (json)
      effects.push({
        kind: 'file-edit',
        edit: JSON.parse(json) as ToolEditPayload,
        ...(value.userModified === true ? { userModified: true } : {}),
      })
  }
  if (value.gitOperation !== undefined) {
    const operation =
      typeof value.gitOperation === 'string'
        ? value.gitOperation
        : JSON.stringify(value.gitOperation)
    if (operation) effects.push({ kind: 'git-operation', operation: operation.slice(0, 2000) })
  }
  if (typeof value.backgroundTaskId === 'string')
    effects.push({ kind: 'background-task', taskId: value.backgroundTaskId.slice(0, 1000) })
  if (
    value.interrupted === true ||
    typeof value.timedOutAfterMs === 'number' ||
    typeof value.returnCodeInterpretation === 'string'
  ) {
    effects.push({
      kind: 'termination',
      ...(value.interrupted === true ? { interrupted: true } : {}),
      ...(typeof value.timedOutAfterMs === 'number'
        ? { timedOutAfterMs: value.timedOutAfterMs }
        : {}),
      ...(typeof value.returnCodeInterpretation === 'string'
        ? { interpretation: value.returnCodeInterpretation.slice(0, 2000) }
        : {}),
    })
  }
  if (typeof value.stderr === 'string' && value.stderr)
    effects.push({ kind: 'stderr', text: value.stderr.slice(0, 2000) })
  return effects
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
