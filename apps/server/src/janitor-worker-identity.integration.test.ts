import { expect, test } from 'vitest'
import { openDatabase } from '@podium/runtime/sqlite'
import { DRIZZLE_MIGRATIONS } from './migrations/drizzle-manifest.generated'
import { runDrizzleMigrations } from './migrations'

// Keep migrations and the real worker: neither shares the subprocess identity slot.
test('independent janitor worker resolves its owner from a migrated database', async () => {
  const { execFileSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), 'phase-a-worker-review-'))
  const dbPath = join(dir, 'podium.db')
  const db = openDatabase(dbPath)
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
  db.close()
  try {
    const output = execFileSync('bun', ['--conditions=@podium/source', '-e', `
      import { firstAdminMemberIdOrUndefined } from './packages/model/src/identity/first-admin.ts';
      if (firstAdminMemberIdOrUndefined() !== undefined) throw new Error('test host unexpectedly primed');
      import { JanitorWorkerClient } from './packages/janitor/src/worker-client.ts';
      const client = new JanitorWorkerClient({ serverUrl: 'http://127.0.0.1:1', token: 'review', dbPath: process.env.REVIEW_DATABASE, tickMs: 60000 });
      const deadline = Date.now() + 8000;
      while (client.state() !== 'running' && Date.now() < deadline) await Bun.sleep(20);
      console.log(client.state() === 'running' ? 'SMOKE_OK' : 'SMOKE_BAD ' + client.reason());
      await client.close();
    `], { cwd: root, env: { ...process.env, REVIEW_DATABASE: dbPath }, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] })
    expect(output).toContain('SMOKE_OK')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 20000)
