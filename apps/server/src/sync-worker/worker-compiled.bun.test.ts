import { expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openTestStore } from '../test-support/open-test-store'
import { SYNC_WORKER_ENTRY } from './sync-worker-embed'

it('embeds and executes the real bootstrap producer in a standalone binary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-compiled-'))
  try {
    const path = join(dir, 'test.db')
    const store = await openTestStore(path)
    await store.close()
    const binary = join(dir, 'smoke')
    execFileSync('bun', ['build', '--compile', '--conditions=@podium/source', 'scripts/sync-worker-smoke.ts', SYNC_WORKER_ENTRY, '--outfile', binary], {
      cwd: fileURLToPath(new URL('../../../../..', import.meta.url)), stdio: 'pipe', timeout: 60_000,
    })
    expect(execFileSync(binary, [path], { encoding: 'utf8', timeout: 20_000 })).toContain('SYNC_WORKER_SMOKE_OK')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 90_000)
