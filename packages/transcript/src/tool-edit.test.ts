import { describe, expect, it } from 'vitest'
import {
  extractToolEdit,
  extractToolEditFromPatch,
  safeToolEditJson,
  safeToolEditJsonFromInput,
  TOOL_EDIT_KIND,
} from './tool-edit'

describe('extractToolEdit', () => {
  it('reads a Claude / Grok search-replace as one replace hunk', () => {
    const edit = extractToolEdit('Edit', {
      file_path: '/repo/a.ts',
      old_string: 'const a = 1',
      new_string: 'const a = 2',
    })
    expect(edit).toMatchObject({
      kind: TOOL_EDIT_KIND,
      path: '/repo/a.ts',
      mode: 'replace',
      added: 1,
      removed: 1,
    })
    expect(edit?.hunks).toEqual([{ path: '/repo/a.ts', oldText: 'const a = 1', newText: 'const a = 2' }])
  })

  it('reads a MultiEdit list as several hunks', () => {
    const edit = extractToolEdit('MultiEdit', {
      file_path: 'chat.ts',
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'c', new_string: 'd' },
      ],
    })
    expect(edit?.mode).toBe('replace')
    expect(edit?.hunks).toHaveLength(2)
    expect(edit?.added).toBe(2)
    expect(edit?.removed).toBe(2)
  })

  it('reads a Write as a new-file payload', () => {
    const edit = extractToolEdit('Write', { target_file: 'n.ts', contents: 'export const n = 1\n' })
    expect(edit).toMatchObject({ kind: TOOL_EDIT_KIND, path: 'n.ts', mode: 'write', added: 1, removed: 0 })
    expect(edit?.hunks[0]?.newText).toContain('export const n = 1')
  })

  it('reads camelCase OpenCode / Cursor fields', () => {
    const edit = extractToolEdit('StrReplace', {
      filePath: 'x.ts',
      oldString: 'old',
      newString: 'new',
    })
    expect(edit).toMatchObject({ path: 'x.ts', mode: 'replace' })
    expect(edit?.hunks[0]).toMatchObject({ oldText: 'old', newText: 'new' })
  })

  it('ignores a Read — a path alone is not an edit', () => {
    expect(extractToolEdit('Read', { file_path: '/repo/a.ts' })).toBeUndefined()
  })

  it('ignores Bash', () => {
    expect(extractToolEdit('Bash', { command: 'ls' })).toBeUndefined()
  })

  it('recovers an apply_patch string', () => {
    const patch =
      '*** Begin Patch\n*** Update File: packages/transcript/src/codex.ts\n@@\n-old\n+new\n*** End Patch'
    const edit = extractToolEdit('apply_patch', patch)
    expect(edit).toMatchObject({
      kind: TOOL_EDIT_KIND,
      path: 'packages/transcript/src/codex.ts',
      mode: 'patch',
      added: 1,
      removed: 1,
    })
    expect(edit?.patch).toContain('*** Update File:')
  })
})

describe('extractToolEditFromPatch', () => {
  it('names a create-only patch as write', () => {
    const edit = extractToolEditFromPatch(
      '*** Begin Patch\n*** Add File: new.ts\n+ consola\n*** End Patch',
    )
    expect(edit).toMatchObject({ mode: 'write', path: 'new.ts', added: 1, removed: 0 })
  })
})

describe('safeToolEditJson', () => {
  it('round-trips a small edit', () => {
    const edit = extractToolEdit('Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' })
    expect(edit).toBeDefined()
    const json = safeToolEditJson(edit!)
    expect(json).toBeDefined()
    expect(JSON.parse(json!)).toMatchObject({ kind: TOOL_EDIT_KIND, path: 'a.ts' })
  })

  it('trims a huge write rather than dropping the payload', () => {
    const json = safeToolEditJsonFromInput('Write', {
      file_path: 'big.ts',
      contents: 'x'.repeat(80_000),
    })
    expect(json).toBeDefined()
    expect(json!.length).toBeLessThan(24_000)
    const parsed = JSON.parse(json!) as { truncated?: boolean; added: number; path?: string }
    expect(parsed.path).toBe('big.ts')
    expect(parsed.truncated).toBe(true)
    expect(parsed.added).toBeGreaterThan(0)
  })

  it('returns undefined for a non-edit', () => {
    expect(safeToolEditJsonFromInput('Bash', { command: 'ls' })).toBeUndefined()
  })
})
