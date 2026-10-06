import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fsyncPath, fsyncPathAsync } from './fsync'

describe('fsyncPath', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('flushes a file and its directory', async () => {
    dir = mkdtempSync(join(tmpdir(), 'podium-fsync-'))
    const file = join(dir, 'state.json')
    writeFileSync(file, '{}')
    expect(() => fsyncPath(file)).not.toThrow()
    expect(() => fsyncPath(dir as string)).not.toThrow()
    await expect(fsyncPathAsync(file)).resolves.toBeUndefined()
    await expect(fsyncPathAsync(dir)).resolves.toBeUndefined()
  })
})
