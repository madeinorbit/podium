import { EFFECT_KEYS, IGNORED_EFFECT_KEYS } from './claude-coverage'
import { safeToolEditJson, type ToolEditPayload } from './tool-edit'

/** Wire type is canonical; edits still use the existing normalization budget. */
export type ToolEffect = NonNullable<import('@podium/model').TranscriptItem['toolEffects']>[number]

export function claudeToolEffects(value: unknown): ToolEffect[] {
  if (!isRecord(value)) return []
  const effects: ToolEffect[] = []
  const bash = isRecord(value.bashEditDiff) ? value.bashEditDiff : undefined
  const files = bash && Array.isArray(bash.files) ? bash.files.filter(isRecord) : []
  if (bash || Array.isArray(value.structuredPatch)) {
    const patchFiles = bash ? files : [{ filePath: value.filePath, hunks: value.structuredPatch }]
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
    const createdContent =
      !files.length && value.type === 'create' && typeof value.content === 'string'
        ? value.content
        : undefined
    const created = createdContent !== undefined
    if (createdContent !== undefined)
      added = createdContent === '' ? 0 : createdContent.replace(/\n$/, '').split('\n').length
    const edit: ToolEditPayload = {
      kind: 'file-edit',
      ...(patchFiles.length === 1 && typeof patchFiles[0]?.filePath === 'string'
        ? { path: patchFiles[0].filePath }
        : {}),
      mode: created ? 'write' : 'patch',
      hunks: createdContent !== undefined ? [{ newText: createdContent }] : [],
      ...(!created ? { patch: sections.join('\n') } : {}),
      added,
      removed,
      ...(bash?.unavailable === true
        ? { unavailable: true }
        : {
            changedFileCount: Array.isArray(bash?.changedFiles)
              ? bash.changedFiles.length
              : patchFiles.length,
          }),
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
  if (isRecord(value.gitOperation)) {
    const operation: Extract<ToolEffect, { kind: 'git-operation' }>['operation'] = {}
    const commit = value.gitOperation.commit
    const branch = value.gitOperation.branch
    if (isRecord(commit)) operation.commit = fields(commit, ['sha', 'kind', 'branch'])
    if (isRecord(branch)) operation.branch = fields(branch, ['ref', 'action'])
    effects.push({ kind: 'git-operation', operation })
  }
  if (typeof value.backgroundTaskId === 'string')
    effects.push({ kind: 'background-task', taskId: value.backgroundTaskId.slice(0, 1000) })
  if (
    value.interrupted === true ||
    typeof value.timedOutAfterMs === 'number' ||
    (typeof value.returnCodeInterpretation === 'string' &&
      value.returnCodeInterpretation !== 'No matches found')
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
  for (const key of Object.keys(value)) {
    if (!EFFECT_KEYS.has(key) && !Object.hasOwn(IGNORED_EFFECT_KEYS, key))
      effects.push({ kind: 'unknown', key: key.slice(0, 160) })
  }
  // The entire effect list, not each file, shares one transport budget.
  if (JSON.stringify(effects).length > 24_000) {
    for (const effect of effects) {
      if (effect.kind === 'file-edit') {
        delete effect.edit.patch
        effect.edit.hunks = []
        effect.edit.truncated = true
      }
    }
  }
  while (effects.length > 1 && JSON.stringify(effects).length > 24_000) effects.pop()

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

function fields(value: Record<string, unknown>, keys: string[]): Record<string, string> {
  return Object.fromEntries(
    keys.flatMap((key) =>
      typeof value[key] === 'string' ? [[key, value[key].slice(0, 500)]] : [],
    ),
  )
}
