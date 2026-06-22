import { mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileIdFor, resolveFileChain } from './file-chain.js'

describe('fileIdFor', () => {
  it('is stable and path-derived (no raw path leak)', () => {
    const id = fileIdFor('/home/u/.claude/projects/x/abc.jsonl')
    expect(id).toMatch(/^[a-f0-9]{12}$/)
    expect(fileIdFor('/home/u/.claude/projects/x/abc.jsonl')).toBe(id)
  })
})

describe('resolveFileChain', () => {
  it('orders claude bucket files oldest→newest by mtime', async () => {
    const home = await mkdtemp(join(tmpdir(), 'home-'))
    process.env.HOME = home
    const slug = '/work/repo'.replace(/[^a-zA-Z0-9]/g, '-')
    const dir = join(home, '.claude', 'projects', slug)
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    const older = join(dir, 'older.jsonl')
    const newer = join(dir, 'newer.jsonl')
    await writeFile(older, '{}\n')
    await writeFile(newer, '{}\n')
    await utimes(older, new Date(1000), new Date(1000))
    await utimes(newer, new Date(2000), new Date(2000))
    const chain = await resolveFileChain({ agentKind: 'claude-code', cwd: '/work/repo' })
    expect(chain.map((c) => c.path)).toEqual([older, newer])
  })
})
