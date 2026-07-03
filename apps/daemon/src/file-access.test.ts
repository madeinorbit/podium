import {
  mkdtemp,
  mkdir,
  readFile,
  symlink,
  writeFile,
  writeFile as writeFileFs,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isInside,
  listDirSandboxed,
  readAssetSandboxed,
  readFileSandboxed,
  writeFileSandboxed,
} from './file-access'

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

  // TOCTOU guard: if the path resolves to a directory (stat succeeds but isFile()
  // is false), the post-realpath branch must return ok:false without throwing.
  it('resolves ok:false (no throw) when the target is a directory inside cwd', async () => {
    const cwd = await repo()
    const dir = join(cwd, 'subdir')
    await mkdir(dir)
    // Exercises the post-realpath st.isFile() === false branch
    await expect(readFileSandboxed({ cwd, path: dir, knownPath: false })).resolves.toMatchObject({
      ok: false,
    })
  })

  // TOCTOU guard: a broken symlink inside cwd makes realpath throw → caught by the
  // existing outer try/catch, returning ok:false without an unhandled rejection.
  it('resolves ok:false (no throw) for a broken symlink inside cwd', async () => {
    const cwd = await repo()
    await symlink(join(cwd, 'nonexistent'), join(cwd, 'broken'))
    await expect(
      readFileSandboxed({ cwd, path: join(cwd, 'broken'), knownPath: false }),
    ).resolves.toMatchObject({ ok: false })
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

  // TOCTOU guard: if writeFile throws (e.g. path resolves to a directory), the
  // function must RESOLVE to an error object rather than rejecting.
  it('resolves ok:false (no throw) when the target path is a directory', async () => {
    const cwd = await repo()
    const dir = join(cwd, 'adir')
    await mkdir(dir)
    // writeFile to a directory throws EISDIR — the post-sandbox try/catch must catch it.
    await expect(writeFileSandboxed({ cwd, path: dir, content: 'oops' })).resolves.toMatchObject({
      ok: false,
    })
  })
})

describe('readAssetSandboxed', () => {
  it('returns base64 bytes + content-type for an in-sandbox image', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asset-'))
    const png = Buffer.from('89504e470d0a1a0a', 'hex') // PNG magic bytes
    await writeFileFs(join(dir, 'a.png'), png)
    const r = await readAssetSandboxed({ cwd: dir, path: join(dir, 'a.png'), knownPath: false })
    expect(r.ok).toBe(true)
    expect(r.contentType).toBe('image/png')
    expect(Buffer.from(r.dataBase64 ?? '', 'base64').equals(png)).toBe(true)
  })
  it('returns a stylesheet content-type for css assets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asset-'))
    await writeFileFs(join(dir, 'site.css'), 'body { color: red; }')
    const r = await readAssetSandboxed({ cwd: dir, path: join(dir, 'site.css'), knownPath: false })
    expect(r.ok).toBe(true)
    expect(r.contentType).toBe('text/css; charset=utf-8')
  })
  it('rejects a path outside the sandbox', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asset-'))
    const r = await readAssetSandboxed({ cwd: dir, path: '/etc/hosts', knownPath: false })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('outside workspace')
  })
})

describe('listDirSandboxed', () => {
  it('lists entries inside root, dirs first then files, alpha', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pod-ls-'))
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, 'b.ts'), 'b')
    await writeFile(join(dir, 'a.md'), 'a')
    const r = await listDirSandboxed({ root: dir })
    expect(r.ok).toBe(true)
    expect(r.entries).toEqual([
      { name: 'src', isDir: true },
      { name: 'a.md', isDir: false },
      { name: 'b.ts', isDir: false },
    ])
  })

  it('lists a nested subdir under root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pod-ls-'))
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, 'src', 'index.ts'), 'x')
    const r = await listDirSandboxed({ root: dir, path: join(dir, 'src') })
    expect(r.ok).toBe(true)
    expect(r.entries).toEqual([{ name: 'index.ts', isDir: false }])
  })

  it('rejects a path outside root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pod-ls-'))
    const outside = await mkdtemp(join(tmpdir(), 'pod-out-'))
    const r = await listDirSandboxed({ root: dir, path: outside })
    expect(r).toMatchObject({ ok: false, error: 'outside workspace' })
  })

  it('returns ok:false when the path is not a directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pod-ls-'))
    const f = join(dir, 'a.ts')
    await writeFile(f, 'x')
    const r = await listDirSandboxed({ root: dir, path: f })
    expect(r.ok).toBe(false)
  })
})
