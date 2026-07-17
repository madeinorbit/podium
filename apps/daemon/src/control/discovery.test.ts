import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listDirectories } from './discovery'

// The browse target is the DAEMON's disk (POD-814) [spec:SP-3701]: these exercise
// the real filesystem in a tmp tree rather than a mocked readdir, so the ~ / realpath
// / hidden-filter behaviour is checked against the thing that actually decides.
describe('listDirectories (daemon-side repo picker browse)', () => {
  let root: string
  let home: string
  const realHome = process.env.HOME

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'podium-browse-'))
    home = join(root, 'home', 'user')
    await mkdir(join(home, 'src'), { recursive: true })
    await mkdir(join(home, 'archive'), { recursive: true })
    await mkdir(join(home, '.config'), { recursive: true })
    await writeFile(join(home, 'notes.md'), 'not a directory')
    process.env.HOME = home
  })

  afterEach(async () => {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    await rm(root, { recursive: true, force: true })
  })

  it('browses $HOME when no path is given, directories only, hidden filtered', async () => {
    const listing = await listDirectories(undefined)
    expect(listing.path).toBe(await realpathOf(home))
    expect(listing.homePath).toBe(home)
    expect(listing.entries.map((e) => e.name)).toEqual(['archive', 'src'])
  })

  it('includes dot-directories only when includeHidden is set', async () => {
    const listing = await listDirectories(home, { includeHidden: true })
    expect(listing.entries.map((e) => e.name)).toEqual(['.config', 'archive', 'src'])
  })

  it('expands ~ against the live $HOME', async () => {
    const listing = await listDirectories('~/src')
    expect(listing.path).toBe(await realpathOf(join(home, 'src')))
    expect(await listDirectories('~').then((l) => l.path)).toBe(await realpathOf(home))
  })

  it('prefers live $HOME over the snapshotted ctx home', async () => {
    const other = join(root, 'other-home')
    await mkdir(other, { recursive: true })
    const listing = await listDirectories(undefined, { homeDir: other })
    expect(listing.homePath).toBe(home)
  })

  it('falls back to the ctx home when $HOME is unset', async () => {
    delete process.env.HOME
    const listing = await listDirectories(undefined, { homeDir: home })
    expect(listing.homePath).toBe(home)
  })

  it('reports parentPath, and null at the filesystem root', async () => {
    expect((await listDirectories(join(home, 'src'))).parentPath).toBe(await realpathOf(home))
    expect((await listDirectories('/')).parentPath).toBeNull()
  })

  it('resolves a symlinked path to its realpath', async () => {
    const link = join(root, 'link-to-src')
    await symlink(join(home, 'src'), link)
    expect((await listDirectories(link)).path).toBe(await realpathOf(join(home, 'src')))
  })

  it('rejects a relative path', async () => {
    await expect(listDirectories('src')).rejects.toThrow(/must be absolute/)
  })

  it('rejects a file and a missing directory', async () => {
    await expect(listDirectories(join(home, 'notes.md'))).rejects.toThrow(/not a directory/)
    await expect(listDirectories(join(home, 'nope'))).rejects.toThrow(/Could not open directory/)
  })
})

/** macOS tmpdir is itself a symlink (/var → /private/var), so expectations that
 *  compare against a tmp path must compare realpaths too. */
async function realpathOf(path: string): Promise<string> {
  const { realpath } = await import('node:fs/promises')
  return realpath(path)
}
