import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RepoRegistry } from './repo-registry'

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'podium-reporeg-'))
  return join(dir, 'repos.json')
}

describe('RepoRegistry', () => {
  it('starts empty, adds, dedupes, lists, removes', async () => {
    const file = await tmpFile()
    const reg = new RepoRegistry(file)
    await reg.load()
    expect(reg.list()).toEqual([])
    await reg.add('/home/u/src/app')
    await reg.add('/home/u/src/app') // dedupe
    expect(reg.list()).toEqual(['/home/u/src/app'])
    await reg.remove('/home/u/src/app')
    expect(reg.list()).toEqual([])
  })

  it('rejects non-absolute and empty paths', async () => {
    const reg = new RepoRegistry(await tmpFile())
    await reg.load()
    await expect(reg.add('')).rejects.toThrow()
    await expect(reg.add('relative/path')).rejects.toThrow()
  })

  it('persists across instances', async () => {
    const file = await tmpFile()
    const a = new RepoRegistry(file)
    await a.load()
    await a.add('/abs/one')
    const b = new RepoRegistry(file)
    await b.load()
    expect(b.list()).toEqual(['/abs/one'])
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(['/abs/one'])
  })

  it('tolerates a corrupt file', async () => {
    const file = await tmpFile()
    await writeFile(file, 'not json')
    const reg = new RepoRegistry(file)
    await reg.load()
    expect(reg.list()).toEqual([])
  })
})
