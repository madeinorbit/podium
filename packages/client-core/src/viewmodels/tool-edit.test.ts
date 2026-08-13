import { describe, expect, it } from 'vitest'
import { parseToolEdit, toolEditLines, toolEditMagnitude } from './tool-edit'

const replaceJson = JSON.stringify({
  kind: 'file-edit',
  path: 'a.ts',
  mode: 'replace',
  hunks: [{ path: 'a.ts', oldText: 'const a = 1\nconst b = 2', newText: 'const a = 1\nconst b = 3' }],
  added: 2,
  removed: 2,
})

describe('parseToolEdit', () => {
  it('reads a file-edit payload and ignores an ask card', () => {
    expect(parseToolEdit(replaceJson)).toMatchObject({ kind: 'file-edit', path: 'a.ts', mode: 'replace' })
    expect(parseToolEdit(JSON.stringify({ questions: [] }))).toBeUndefined()
    expect(parseToolEdit(undefined)).toBeUndefined()
  })
})

describe('toolEditMagnitude', () => {
  it('prints plus and minus counts', () => {
    const edit = parseToolEdit(replaceJson)!
    expect(toolEditMagnitude(edit)).toBe('+2 −2')
  })

  it('names a write with no line counts as a new file', () => {
    expect(
      toolEditMagnitude({
        kind: 'file-edit',
        mode: 'write',
        hunks: [],
        added: 0,
        removed: 0,
      }),
    ).toBe('new file')
  })
})

describe('toolEditLines', () => {
  it('diffs a replace hunk at line grain — shared lines stay context', () => {
    const { lines } = toolEditLines(parseToolEdit(replaceJson)!)
    expect(lines).toEqual([
      { kind: 'hunk', text: 'a.ts' },
      { kind: 'ctx', text: 'const a = 1' },
      { kind: 'del', text: 'const b = 2' },
      { kind: 'add', text: 'const b = 3' },
    ])
  })

  it('paints a write as added lines', () => {
    const { lines } = toolEditLines({
      kind: 'file-edit',
      path: 'n.ts',
      mode: 'write',
      hunks: [{ path: 'n.ts', newText: 'one\ntwo\n' }],
      added: 2,
      removed: 0,
    })
    expect(lines).toEqual([
      { kind: 'hunk', text: 'n.ts' },
      { kind: 'add', text: 'one' },
      { kind: 'add', text: 'two' },
    ])
  })

  it('colours an apply_patch body and drops the wrapper lines', () => {
    const { lines } = toolEditLines({
      kind: 'file-edit',
      path: 'codex.ts',
      mode: 'patch',
      hunks: [],
      patch:
        '*** Begin Patch\n*** Update File: packages/transcript/src/codex.ts\n@@\n context\n-old\n+new\n*** End Patch',
      added: 1,
      removed: 1,
    })
    expect(lines.map((l) => l.kind)).toEqual(['hunk', 'meta', 'ctx', 'del', 'add'])
    expect(lines[0]?.text).toContain('codex.ts')
    expect(lines.find((l) => l.kind === 'del')?.text).toBe('old')
    expect(lines.find((l) => l.kind === 'add')?.text).toBe('new')
  })

  it('states when the stored payload was truncated to nothing', () => {
    const { lines } = toolEditLines({
      kind: 'file-edit',
      path: 'big.ts',
      mode: 'write',
      hunks: [],
      added: 4000,
      removed: 0,
      truncated: true,
    })
    expect(lines[0]?.kind).toBe('note')
    expect(lines[0]?.text).toMatch(/open the file/i)
  })
})
