import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { expect, it } from 'vitest'
import { noJanitorWorkerForTests } from './janitor-host'
import { runDrizzleMigrations } from './migrations'
import { DRIZZLE_MIGRATIONS } from './migrations/drizzle-manifest.generated'
import { OperationStore } from './modules/operations/store'
import { UPDATE_OPERATION_KIND, UPDATE_STEP_SERVER } from './modules/updates/operation'
import { startServer, type ServerHandle } from './server'
import { syncQueriesOver } from './store/executor/sync-drizzle'

it('startServer adopts a durable update using resolved production fleet records', async () => {
  const root = mkdtempSync(join(tmpdir(), 'podium-update-adoption-'))
  const priorStateDir = process.env.PODIUM_STATE_DIR
  const priorVersion = process.env.PODIUM_APP_VERSION
  let handle: ServerHandle | undefined
  try {
    process.env.PODIUM_STATE_DIR = root
    process.env.PODIUM_APP_VERSION = '2.0.0'
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      configVersion: 2, mode: 'server', persistence: 'detached',
    }))
    // Persist the outgoing coordinator's unfinished operation, then close its
    // database. Only startServer assembles the successor's adoption callback.
    const db = openDatabase(join(root, 'podium.db'))
    try {
      runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
      await new OperationStore(syncQueriesOver(db)).insert({
        id: 'update-before-restart',
        kind: UPDATE_OPERATION_KIND,
        exclusionGroup: 'lifecycle',
        state: 'running',
        createdAt: 1,
        startedAt: 1,
        updatedAt: 1,
        details: {
          channel: 'dev',
          fromVersion: '1.0.0',
          target: { version: '2.0.0', critical: false, artifacts: {} },
        },
        steps: [{ id: UPDATE_STEP_SERVER, title: 'Updating the server', state: 'running' }],
        awaiting: [],
        deferred: [],
        error: null,
      })
    } finally {
      db.close()
    }

    handle = await startServer({ port: 0, janitorWorkerForTests: noJanitorWorkerForTests })
    const engine = handle.registry.modules.operations.engine
    await engine.whenSettled('update-before-restart')
    const adopted = (await engine.get('update-before-restart'))?.operation
    expect(adopted?.error).toBeNull()
    expect(adopted).toMatchObject({
      state: 'done',
      steps: [{ id: UPDATE_STEP_SERVER, state: 'done' }],
    })
  } finally {
    await handle?.close()
    if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = priorStateDir
    if (priorVersion === undefined) delete process.env.PODIUM_APP_VERSION
    else process.env.PODIUM_APP_VERSION = priorVersion
    rmSync(root, { recursive: true, force: true })
  }
})
