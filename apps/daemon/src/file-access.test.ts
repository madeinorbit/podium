import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isInside, readFileSandboxed, writeFileSandboxed } from './file-access'

async function repo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'podium-fa-'))
}

describe('isInside', () => {
  it('accepts a child path and rejects siblings / traversal', () => {
    expect(isInside('/r/a/b.ts', '/r')).toBe(true)
    expect(isInside('/r', '/r')).toBe(true)
    expect(isInside('/r-evil/x', '/r')).toBe(false)
    expect(isInside('/other', '/r')).toBe(false)
  })
})

describe('readFileSandboxed', () => {
  it('reads a file inside cwd and returns content + baseHash', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'a.ts'), 'hello')
    const r = await readFileSandboxed({ cwd, path: join(cwd, 'a.ts'), knownPath: false })
    expect(r.ok).toBe(true)
    expect(r.content).toBe('hello')
    expect(r.baseHash).toMatch(/^\d+(\.\d+)?:5$/)
  })

  it('rejects a path outside cwd when not knownPath', async () => {
    const cwd = await repo()
    const outside = await repo()
    await writeFile(join(outside, 'secret'), 'x')
    const r = await readFileSandboxed({ cwd, path: join(outside, 'secret'), knownPath: false })
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('allows an outside path when knownPath is true', async () => {
    const cwd = await repo()
    const outside = await repo()
    await writeFile(join(outside, 'memo.md'), 'note')
    const r = await readFileSandboxed({ cwd, path: join(outside, 'memo.md'), knownPath: true })
    expect(r.ok).toBe(true)
    expect(r.content).toBe('note')
  })

  it('rejects a symlink that escapes cwd', async () => {
    const cwd = await repo()
    const outside = await repo()
    await writeFile(join(outside, 'secret'), 'x')
    await symlink(join(outside, 'secret'), join(cwd, 'link'))
    const r = await readFileSandboxed({ cwd, path: join(cwd, 'link'), knownPath: false })
    expect(r.ok).toBe(false)
  })
})

describe('writeFileSandboxed', () => {
  it('writes inside cwd and detects a stale baseHash conflict', async () => {
    const cwd = await repo()
    const p = join(cwd, 'a.ts')
    await writeFile(p, 'orig')
    const ok = await writeFileSandboxed({ cwd, path: p, content: 'new' })
    expect(ok.ok).toBe(true)
    expect(await readFile(p, 'utf8')).toBe('new')
    const conflict = await writeFileSandboxed({ cwd, path: p, content: 'x', baseHash: 'stale:1' })
    expect(conflict.ok).toBe(false)
    expect(conflict.conflict).toBe(true)
  })

  it('refuses to write outside cwd', async () => {
    const cwd = await repo()
    const outside = await repo()
    const r = await writeFileSandboxed({ cwd, path: join(outside, 'x'), content: 'y' })
    expect(r.ok).toBe(false)
  })
})
