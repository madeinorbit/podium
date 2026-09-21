import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveWithinRoots } from './scanner.js'

// The mirror-read guard (docs/spec/transcript-mirror.md invariant 3): the daemon
// must never serve bytes from outside its discovery roots — including via
// prefix-collision dirs and symlinks that ESCAPE a root.
describe('resolveWithinRoots', () => {
  async function seed(): Promise<{ base: string; root: string; file: string }> {
    const base = await mkdtemp(join(tmpdir(), 'podium-guard-'))
    const root = join(base, '.claude')
    await mkdir(join(root, 'projects', '-w'), { recursive: true })
    const file = join(root, 'projects', '-w', 'sess.jsonl')
    await writeFile(file, '{"type":"user"}\n')
    return { base, root, file }
  }

  it('admits a file inside a root and returns its realpath', async () => {
    const { root, file } = await seed()
    expect(await resolveWithinRoots(file, [root])).toBe(file)
  })

  it('refuses files outside every root (and nonexistent roots allow nothing)', async () => {
    const { base, root } = await seed()
    const outside = join(base, 'outside.txt')
    await writeFile(outside, 'secret')
    expect(await resolveWithinRoots(outside, [root])).toBeNull()
    expect(await resolveWithinRoots('/etc/passwd', [root])).toBeNull()
    expect(await resolveWithinRoots(outside, [join(base, 'no-such-root')])).toBeNull()
  })

  it('refuses a prefix-collision sibling (<root>-evil)', async () => {
    const { base, root } = await seed()
    const evil = join(base, '.claude-evil')
    await mkdir(evil, { recursive: true })
    const f = join(evil, 'x.jsonl')
    await writeFile(f, 'x')
    expect(await resolveWithinRoots(f, [root])).toBeNull()
  })

  it('refuses a symlink inside a root that points OUTSIDE it', async () => {
    const { base, root } = await seed()
    const secret = join(base, 'secret.txt')
    await writeFile(secret, 'do not serve')
    const link = join(root, 'projects', '-w', 'sneaky.jsonl')
    await symlink(secret, link)
    // The link path is under the root, but its REAL location is not.
    expect(await resolveWithinRoots(link, [root])).toBeNull()
  })

  it('returns null for a vanished file instead of throwing', async () => {
    const { root } = await seed()
    expect(await resolveWithinRoots(join(root, 'projects', '-w', 'gone.jsonl'), [root])).toBeNull()
  })
})
