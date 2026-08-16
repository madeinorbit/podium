import { describe, expect, it } from 'vitest'
import {
  parseToolEdit,
  toolEditLines,
  toolEditMagnitude,
  toolEditUnifiedDiff,
} from './tool-edit'

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

describe('toolEditUnifiedDiff', () => {
  it('renders the recorded change as a unified diff a viewer can parse', () => {
    const edit = parseToolEdit(replaceJson)!
    expect(toolEditUnifiedDiff(edit)).toBe([' const a = 1', '-const b = 2', '+const b = 3'].join('\n'))
  })

  it('omits line numbers it does not have rather than counting from a made-up 1', () => {
    const edit = parseToolEdit(
      JSON.stringify({
        kind: 'file-edit',
        mode: 'replace',
        hunks: [
          { path: 'a.ts', oldText: 'one', newText: 'ONE' },
          { path: 'b.ts', oldText: 'two', newText: 'TWO' },
        ],
        added: 2,
        removed: 2,
      }),
    )!
    const out = toolEditUnifiedDiff(edit)
    // Two places → each gets a header, and the header carries no offsets.
    expect(out.split('\n').filter((l) => l.startsWith('@@'))).toEqual(['@@ @@ a.ts', '@@ @@ b.ts'])
    expect(out).not.toMatch(/@@ -\d/)
  })

  it("keeps a patch's own hunk headers, which DO know where they are", () => {
    const edit = parseToolEdit(
      JSON.stringify({
        kind: 'file-edit',
        path: 'codex.ts',
        mode: 'patch',
        hunks: [],
        patch:
          '*** Begin Patch\n*** Update File: codex.ts\n@@ -12,3 +12,3 @@\n context\n-old\n+new\n*** End Patch',
        added: 1,
        removed: 1,
      }),
    )!
    expect(toolEditUnifiedDiff(edit)).toContain('@@ -12,3 +12,3 @@')
  })

  it('says how much of a long edit the transcript did not keep', () => {
    const edit = parseToolEdit(
      JSON.stringify({
        kind: 'file-edit',
        path: 'big.ts',
        mode: 'write',
        hunks: [{ newText: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') }],
        added: 40,
        removed: 0,
      }),
    )!
    // The cap counts the file label too, so ten kept rows are nine of content.
    expect(toolEditUnifiedDiff(edit, 10)).toMatch(/\\ 31 more lines not recorded/)
  })
})
