import { expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyBaselineSchema } from '../migrations'
import { openDatabase } from '@podium/runtime/sqlite'
import { SYNC_WORKER_ENTRY } from './sync-worker-embed'

it('embeds and executes bootstrap and delta producers in a standalone binary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-compiled-'))
  try {
    const path = join(dir, 'test.db')
    const db = openDatabase(path)
    try { applyBaselineSchema(db) } finally { db.close() }
    const binary = join(dir, 'smoke')
    execFileSync('bun', ['build', '--compile', '--conditions=@podium/source', 'scripts/sync-worker-smoke.ts', SYNC_WORKER_ENTRY, '--outfile', binary], {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)), stdio: 'pipe', timeout: 60_000,
    })
    expect(execFileSync(binary, [path], { encoding: 'utf8', timeout: 20_000 })).toContain('SYNC_WORKER_SMOKE_OK')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 90_000)
