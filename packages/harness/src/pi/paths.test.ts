import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  locatePiSessionFile,
  piCwdFromSlug,
  piCwdSlug,
  piSessionDir,
  piSessionIdFromPath,
} from './paths.js'

describe('pi session paths', () => {
  it('encodes the cwd bucket the way pi 0.84.4 does', () => {
    // Observed on disk: /tmp/claude-1000/-home-mgw/x → --tmp-claude-1000--home-mgw-x--
    expect(piCwdSlug('/tmp/claude-1000/-home-mgw/x')).toBe('--tmp-claude-1000--home-mgw-x--')
    expect(piCwdSlug('/home/user/src/podium')).toBe('--home-user-src-podium--')
    expect(piCwdFromSlug('--home-user-src-podium--')).toBe('/home/user/src/podium')
    expect(piCwdFromSlug('not-a-bucket')).toBeUndefined()
  })

  it('reads the session id off the `<timestamp>_<uuid>.jsonl` file name', () => {
    expect(
      piSessionIdFromPath(
        '/x/sessions/--a--/2026-09-02T09-48-46-898Z_9e804279-978a-4644-adc4-f815f25a5728.jsonl',
      ),
    ).toBe('9e804279-978a-4644-adc4-f815f25a5728')
    expect(piSessionIdFromPath('/x/sessions/--a--/notes.txt')).toBeUndefined()
  })

  it('locates a session by id in the cwd bucket, then anywhere under the root', async () => {
    const home = await mkdtemp(join(tmpdir(), 'podium-pi-paths-'))
    const id = '9e804279-978a-4644-adc4-f815f25a5728'
    const bucket = piSessionDir('/work/here', home)
    await mkdir(bucket, { recursive: true })
    const file = join(bucket, `2026-09-02T09-48-46-898Z_${id}.jsonl`)
    await writeFile(file, '{"type":"session","version":3,"id":"' + id + '"}\n')

    expect(await locatePiSessionFile({ cwd: '/work/here', sessionId: id, homeDir: home })).toBe(
      file,
    )
    // The worktree moved: the file still lives under its creation-time cwd.
    expect(
      await locatePiSessionFile({ cwd: '/work/elsewhere', sessionId: id, homeDir: home }),
    ).toBe(file)
    expect(
      await locatePiSessionFile({ cwd: '/work/here', sessionId: 'missing', homeDir: home }),
    ).toBeUndefined()
  })
})
