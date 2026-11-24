import { execFileSync } from 'node:child_process'
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
  writeFile as writeFileFs,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  hasGitSegment,
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

  it('a name starting with two dots is a child, a parent step is not (POD-7503)', () => {
    expect(isInside('/r/..foo', '/r')).toBe(true)
    expect(isInside('/r/..', '/r')).toBe(false)
    expect(isInside('/', '/r')).toBe(false)
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
  it.each([
    ['document.pdf', 'application/pdf'],
    ['clip.mov', 'video/quicktime'],
    ['voice.m4a', 'audio/mp4'],
    ['rows.tsv', 'text/tab-separated-values; charset=utf-8'],
  ])('serves %s with its browser viewer content type', async (name, contentType) => {
    const dir = await mkdtemp(join(tmpdir(), 'asset-'))
    await writeFileFs(join(dir, name), 'viewer bytes')
    const r = await readAssetSandboxed({ cwd: dir, path: join(dir, name), knownPath: false })
    expect(r.contentType).toBe(contentType)
  })
  it('serves an unlisted text extension as plain text, not a download', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asset-'))
    await writeFileFs(join(dir, 'notes.md'), '# hi')
    const r = await readAssetSandboxed({ cwd: dir, path: join(dir, 'notes.md'), knownPath: false })
    expect(r.contentType).toBe('text/plain; charset=utf-8')
  })
  it('keeps an unlisted binary extension a download', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asset-'))
    await writeFileFs(join(dir, 'blob.bin'), Buffer.from([0x01, 0x00, 0x02]))
    const r = await readAssetSandboxed({ cwd: dir, path: join(dir, 'blob.bin'), knownPath: false })
    expect(r.contentType).toBe('application/octet-stream')
  })
  it('rejects a path outside the sandbox', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asset-'))
    const r = await readAssetSandboxed({ cwd: dir, path: '/etc/hosts', knownPath: false })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('outside workspace')
  })
  it('ranged reads return the requested slice + total size', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asset-'))
    await writeFileFs(join(dir, 'big.bin'), Buffer.from('0123456789'))
    const path = join(dir, 'big.bin')
    const r = await readAssetSandboxed({ cwd: dir, path, knownPath: false, offset: 4, length: 3 })
    expect(r.ok).toBe(true)
    expect(r.size).toBe(10)
    expect(Buffer.from(r.dataBase64 ?? '', 'base64').toString()).toBe('456')
    // tail-clamped slice
    const tail = await readAssetSandboxed({
      cwd: dir,
      path,
      knownPath: false,
      offset: 8,
      length: 5,
    })
    expect(Buffer.from(tail.dataBase64 ?? '', 'base64').toString()).toBe('89')
  })
})

describe('listDirSandboxed', () => {
  it('lists entries inside root, dirs first then files, alpha', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pod-ls-'))
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, 'b.ts'), 'b')
    await writeFile(join(dir, 'a.md'), 'a')
    const r = await listDirSandboxed({ root: dir, repoRoot: dir })
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
    const r = await listDirSandboxed({ root: dir, repoRoot: dir, path: join(dir, 'src') })
    expect(r.ok).toBe(true)
    expect(r.entries).toEqual([{ name: 'index.ts', isDir: false }])
  })

  it('rejects a path outside root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pod-ls-'))
    const outside = await mkdtemp(join(tmpdir(), 'pod-out-'))
    const r = await listDirSandboxed({ root: dir, repoRoot: dir, path: outside })
    expect(r).toMatchObject({ ok: false, error: 'outside workspace' })
  })

  it('refuses a listing that names no repository (an older server, POD-7503)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pod-ls-'))
    expect(await listDirSandboxed({ root: dir })).toMatchObject({
      ok: false,
      entries: [],
      error: 'repository root required',
    })
  })

  it('returns ok:false when the path is not a directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pod-ls-'))
    const f = join(dir, 'a.ts')
    await writeFile(f, 'x')
    const r = await listDirSandboxed({ root: dir, repoRoot: dir, path: f })
    expect(r.ok).toBe(false)
  })
})

/**
 * POD-7501: the server matches a root against its registered repositories as
 * text, so `<repo>/escape`, a symlink to a folder outside, passes it. The daemon
 * is told which repository matched and must refuse a root that resolves outside
 * it, for every root-addressed request.
 */
describe('a root-addressed request stays inside its repository on disk', () => {
  async function machine() {
    const base = await mkdtemp(join(tmpdir(), 'podium-fa-repo-'))
    const repoRoot = join(base, 'repo')
    const outside = join(base, 'home')
    await mkdir(join(repoRoot, 'src'), { recursive: true })
    await mkdir(outside)
    await writeFile(join(repoRoot, 'src', 'a.ts'), 'inside')
    await writeFile(join(outside, 'secret'), 'private')
    await symlink(outside, join(repoRoot, 'escape'))
    return { base, repoRoot, outside, link: join(repoRoot, 'escape') }
  }

  it('refuses a read, asset read, write and listing through a symlinked root', async () => {
    const { repoRoot, outside, link } = await machine()
    const secret = join(link, 'secret')
    // Without the repository, the old sandbox (the root's own realpath) serves it.
    expect(await readFileSandboxed({ cwd: link, path: secret, knownPath: false })).toMatchObject({
      ok: true,
      content: 'private',
    })
    const refused = { ok: false, error: 'outside repository' }
    expect(
      await readFileSandboxed({ cwd: link, path: secret, knownPath: false, repoRoot }),
    ).toMatchObject(refused)
    expect(
      await readAssetSandboxed({ cwd: link, path: secret, knownPath: false, repoRoot }),
    ).toMatchObject(refused)
    expect(
      await writeFileSandboxed({
        cwd: link,
        path: join(link, 'planted'),
        content: 'x',
        repoRoot,
      }),
    ).toMatchObject(refused)
    expect(await listDirSandboxed({ root: link, repoRoot })).toMatchObject(refused)
    expect(await readFile(secret, 'utf8')).toBe('private')
    await expect(readFile(join(outside, 'planted'), 'utf8')).rejects.toThrow()
  })

  it('refuses a link to / as the root', async () => {
    const { repoRoot } = await machine()
    await symlink('/', join(repoRoot, 'root'))
    expect(
      await listDirSandboxed({
        root: join(repoRoot, 'root'),
        path: join(repoRoot, 'root', 'etc'),
        repoRoot,
      }),
    ).toMatchObject({ ok: false, error: 'outside repository' })
  })

  it('serves the repository and a real folder inside it', async () => {
    const { repoRoot } = await machine()
    const file = join(repoRoot, 'src', 'a.ts')
    for (const cwd of [repoRoot, join(repoRoot, 'src')]) {
      expect(
        await readFileSandboxed({ cwd, path: file, knownPath: false, repoRoot }),
      ).toMatchObject({ ok: true, content: 'inside' })
      expect(
        await readAssetSandboxed({ cwd, path: file, knownPath: false, repoRoot }),
      ).toMatchObject({ ok: true })
      expect(await listDirSandboxed({ root: cwd, repoRoot })).toMatchObject({ ok: true })
    }
    expect(
      await writeFileSandboxed({
        cwd: repoRoot,
        path: join(repoRoot, 'src', 'b.ts'),
        content: 'b',
        repoRoot,
      }),
    ).toMatchObject({ ok: true })
    expect(await readFile(join(repoRoot, 'src', 'b.ts'), 'utf8')).toBe('b')
  })

  it('compares realpaths: a repository registered through a symlink still serves', async () => {
    const { base, repoRoot } = await machine()
    const alias = join(base, 'alias')
    await symlink(repoRoot, alias)
    // A root spelled through the real path, a repository spelled through the alias.
    expect(
      await readFileSandboxed({
        cwd: join(repoRoot, 'src'),
        path: join(repoRoot, 'src', 'a.ts'),
        knownPath: false,
        repoRoot: alias,
      }),
    ).toMatchObject({ ok: true, content: 'inside' })
  })

  it('a root-addressed read gets no transcript-known exception', async () => {
    const { repoRoot, outside } = await machine()
    expect(
      await readFileSandboxed({
        cwd: repoRoot,
        path: join(outside, 'secret'),
        knownPath: true,
        repoRoot,
      }),
    ).toMatchObject({ ok: false, error: 'outside workspace' })
  })

  it('refuses when the repository itself does not resolve', async () => {
    const { base, repoRoot } = await machine()
    expect(await listDirSandboxed({ root: repoRoot, repoRoot: join(base, 'gone') })).toMatchObject({
      ok: false,
      error: 'repository not found',
    })
  })
})

/**
 * POD-7505: git takes instructions from `.git` (`core.fsmonitor` runs a program
 * on the next status, `core.worktree` and a `.git` file point git out of the
 * repository), so a root-addressed save never writes there, however the path
 * spells it. A session's own save has no repository and is not judged here.
 */
describe('a root-addressed write never lands inside .git', () => {
  async function gitRepo() {
    const repoRoot = await repo()
    await mkdir(join(repoRoot, '.git', 'hooks'), { recursive: true })
    await writeFile(join(repoRoot, '.git', 'config'), '[core]\n')
    await mkdir(join(repoRoot, 'x'), { recursive: true })
    return repoRoot
  }

  it.each([['.git/config'], ['.git/hooks/pre-commit'], ['x/.git']])('refuses %s', async (rel) => {
    const repoRoot = await gitRepo()
    const before = await readFile(join(repoRoot, '.git', 'config'), 'utf8')
    const r = await writeFileSandboxed({
      cwd: repoRoot,
      path: join(repoRoot, rel),
      content: '[core]\n\tfsmonitor = touch /tmp/pwned\n',
      repoRoot,
    })
    expect(r).toMatchObject({ ok: false, error: 'refusing to write inside .git' })
    expect(await readFile(join(repoRoot, '.git', 'config'), 'utf8')).toBe(before)
  })

  it('refuses a root that is the .git folder itself, and a link into it', async () => {
    const repoRoot = await gitRepo()
    await symlink(join(repoRoot, '.git'), join(repoRoot, 'meta'))
    for (const [cwd, path] of [
      [join(repoRoot, '.git'), join(repoRoot, '.git', 'config')],
      [repoRoot, join(repoRoot, 'meta', 'config')],
    ] as const) {
      expect(await writeFileSandboxed({ cwd, path, content: 'x', repoRoot })).toMatchObject({
        ok: false,
        error: 'refusing to write inside .git',
      })
    }
  })

  it('compares names as case-insensitive file systems do', () => {
    expect(hasGitSegment('/r/.GIT/config', '/r')).toBe(true)
    expect(hasGitSegment('/r/sub/.Git', '/r')).toBe(true)
    expect(hasGitSegment('/r/.gitignore', '/r')).toBe(false)
    // Windows ends a name at its first ':' (an NTFS stream), as git's is_ntfs_dotgit does.
    expect(hasGitSegment('/r/x/.git::$DATA', '/r', true)).toBe(true)
    expect(hasGitSegment('/r/.GIT. :stream/config', '/r', true)).toBe(true)
    expect(hasGitSegment('/r/GIT~1/config', '/r', true)).toBe(true)
    // POSIX names may hold ':' and '~': there they are other names.
    expect(hasGitSegment('/r/x/.git::$DATA', '/r', false)).toBe(false)
    expect(hasGitSegment('/r/GIT~1/config', '/r', false)).toBe(false)
    // Only the part inside the repository counts.
    expect(hasGitSegment('/home/.git-things/r/a.txt', '/home/.git-things/r')).toBe(false)
  })

  it('control: a name that only starts with .git is an ordinary file', async () => {
    const repoRoot = await gitRepo()
    for (const name of ['.gitignore', '.github']) {
      expect(
        await writeFileSandboxed({
          cwd: repoRoot,
          path: join(repoRoot, name),
          content: 'ok',
          repoRoot,
        }),
      ).toMatchObject({ ok: true })
    }
  })
})

describe('writeFileSandboxed follows a link at the file only to inside the sandbox', () => {
  it('refuses to write through a file symlink that points outside', async () => {
    const cwd = await repo()
    const outside = await repo()
    await writeFile(join(outside, 'bashrc'), 'orig')
    await symlink(join(outside, 'bashrc'), join(cwd, 'rc'))
    const r = await writeFileSandboxed({ cwd, path: join(cwd, 'rc'), content: 'pwned' })
    expect(r).toMatchObject({ ok: false, error: 'outside workspace' })
    expect(await readFile(join(outside, 'bashrc'), 'utf8')).toBe('orig')
  })

  it('refuses a dangling file symlink, which would create its target', async () => {
    const cwd = await repo()
    const outside = await repo()
    await symlink(join(outside, 'new'), join(cwd, 'dangling'))
    const r = await writeFileSandboxed({ cwd, path: join(cwd, 'dangling'), content: 'x' })
    expect(r).toMatchObject({ ok: false, error: 'outside workspace' })
    await expect(readFile(join(outside, 'new'), 'utf8')).rejects.toThrow()
  })

  it('writes through a file symlink that points inside', async () => {
    const cwd = await repo()
    await writeFile(join(cwd, 'real.md'), 'orig')
    await symlink(join(cwd, 'real.md'), join(cwd, 'alias.md'))
    const r = await writeFileSandboxed({ cwd, path: join(cwd, 'alias.md'), content: 'new' })
    expect(r.ok).toBe(true)
    expect(await readFile(join(cwd, 'real.md'), 'utf8')).toBe('new')
  })
})

/**
 * POD-7503: a hard link is its own name to realpath, and a check made before the
 * open says nothing about what the open found. A write is judged on the opened
 * file before anything is cut, and a read refuses anything but a regular file.
 */
describe.skipIf(process.platform === 'win32')('the opened file is judged, not the path', () => {
  it('refuses to write a file hard-linked elsewhere, leaving both names intact', async () => {
    const cwd = await repo()
    const outside = await repo()
    await writeFile(join(outside, 'bashrc'), 'orig')
    await link(join(outside, 'bashrc'), join(cwd, 'rc'))
    const r = await writeFileSandboxed({ cwd, path: join(cwd, 'rc'), content: 'pwned' })
    expect(r).toMatchObject({ ok: false, error: 'file has other hard links' })
    // Nothing was truncated before the refusal.
    expect(await readFile(join(outside, 'bashrc'), 'utf8')).toBe('orig')
  })

  it('refuses a FIFO planted as the file without blocking on it', async () => {
    const cwd = await repo()
    const fifo = join(cwd, 'pipe')
    execFileSync('mkfifo', [fifo])
    expect(await readFileSandboxed({ cwd, path: fifo, knownPath: false })).toMatchObject({
      ok: false,
      error: 'not a file',
    })
    expect(await readAssetSandboxed({ cwd, path: fifo, knownPath: false })).toMatchObject({
      ok: false,
      error: 'not a file',
    })
    expect(await writeFileSandboxed({ cwd, path: fifo, content: 'x' })).toMatchObject({
      ok: false,
    })
  })

  it('still creates, overwrites and conflict-checks an ordinary file', async () => {
    const cwd = await repo()
    const path = join(cwd, 'a.md')
    const created = await writeFileSandboxed({ cwd, path, content: 'one two' })
    expect(created).toMatchObject({ ok: true })
    const shorter = await writeFileSandboxed({
      cwd,
      path,
      content: 'x',
      ...(created.baseHash ? { baseHash: created.baseHash } : {}),
    })
    expect(shorter).toMatchObject({ ok: true })
    expect(await readFile(path, 'utf8')).toBe('x')
    expect(
      await writeFileSandboxed({ cwd, path, content: 'y', baseHash: created.baseHash ?? '' }),
    ).toMatchObject({ ok: false, conflict: true })
    expect(await readFileSandboxed({ cwd, path, knownPath: false })).toMatchObject({
      ok: true,
      content: 'x',
      baseHash: shorter.baseHash,
    })
  })
})
