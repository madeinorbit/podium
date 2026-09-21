import { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { claudeRecordToItems } from './claude'
import { claudeToolEffects } from './tool-effects'

const hunks = [
  { oldStart: 7, oldLines: 1, newStart: 7, newLines: 1, lines: ['-before', '+actually applied'] },
]
const applied = { filePath: '/repo/a.ts', structuredPatch: hunks, userModified: true }
function result(toolUseResult: unknown) {
  return {
    type: 'user',
    uuid: 'r',
    message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: '' }] },
    toolUseResult,
  }
}
describe('Claude observed effects', () => {
  it('places applied hunks on the result and preserves them through the wire schema', () => {
    const item = claudeRecordToItems(result(applied))[0]
    expect(item).toBeDefined()
    const wire = TranscriptItem.parse(item)
    expect(wire.toolEffects?.[0]).toMatchObject({
      kind: 'file-edit',
      userModified: true,
      edit: { mode: 'patch', added: 1, removed: 1 },
    })
    expect(JSON.stringify(wire.toolEffects)).toContain('actually applied')
    expect(JSON.stringify(wire.toolEffects)).toContain('@@ -7,1 +7,1 @@')
    expect(wire.toolInputJson).toBeUndefined()
    expect(claudeRecordToItems(result(applied))).toEqual(claudeRecordToItems(result(applied)))
  })
  it('shares the edit budget across fifty shell-edited files and retains aggregate counts', () => {
    const files = Array.from({ length: 50 }, (_, index) => ({
      filePath: `/repo/${index}.ts`,
      hunks: [{ ...hunks[0], lines: [`-${'a'.repeat(2000)}`, `+${'b'.repeat(2000)}`] }],
    }))
    const effects = claudeToolEffects({
      bashEditDiff: {
        files,
        moreFiles: 4,
        changedFiles: Array.from({ length: 54 }, (_, i) => `/repo/${i}.ts`),
      },
    })
    expect(JSON.stringify(effects).length).toBeLessThanOrEqual(24_000)
    expect(effects[0]).toMatchObject({
      kind: 'file-edit',
      edit: { changedFileCount: 54, moreFiles: 4, added: 50, removed: 50, truncated: true },
    })
  })
  it('uses created content when Write has an empty patch', () => {
    expect(
      claudeToolEffects({
        type: 'create',
        filePath: '/repo/new',
        structuredPatch: [],
        content: 'created\n',
      }),
    ).toMatchObject([
      { kind: 'file-edit', edit: { mode: 'write', added: 1, hunks: [{ newText: 'created\n' }] } },
    ])
  })
  it('emits abnormal termination only when present (synthetic interrupt fixture)', () => {
    expect(claudeToolEffects({ interrupted: false, stdout: '', stderr: '' })).toEqual([])
    expect(
      claudeToolEffects({ interrupted: true, timedOutAfterMs: 250, backgroundTaskId: 'task' }),
    ).toEqual([
      { kind: 'background-task', taskId: 'task' },
      { kind: 'termination', interrupted: true, timedOutAfterMs: 250 },
    ])
  })
  it('retains structured advisory git metadata without trusting malformed refs', () => {
    expect(
      claudeToolEffects({ gitOperation: { branch: { ref: '$(git', action: 'rebased' } } }),
    ).toEqual([
      { kind: 'git-operation', operation: { branch: { ref: '$(git', action: 'rebased' } } },
    ])
  })
  it('does not duplicate a single effect envelope onto parallel results', () => {
    const record = result(applied)
    record.message.content.push({ type: 'tool_result', tool_use_id: 'other', content: '' })
    const items = claudeRecordToItems(record)
    expect(items.slice(0, 2).every((item) => item.toolEffects === undefined)).toBe(true)
    expect(items[2]).toMatchObject({
      toolName: 'Tool effects',
      toolEffects: [{ kind: 'file-edit' }],
    })
    expect(items[2]?.toolUseId).toBeUndefined()
  })
})

it('marks an unavailable shell diff without claiming zero changed files', () => {
  const effects = claudeToolEffects({
    bashEditDiff: { files: [], moreFiles: 0, unavailable: true },
  })
  expect(effects[0]).toMatchObject({ kind: 'file-edit', edit: { unavailable: true } })
  expect(effects[0]?.kind === 'file-edit' && effects[0].edit.changedFileCount).toBeUndefined()
})
