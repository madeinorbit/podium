import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forgetConfig } from '@podium/runtime/config'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { importConfigSettings, SETTINGS_CONFIG_IMPORT } from './settings-config-import'
import { openTestStore } from './test-support/open-test-store'
import { InstanceService } from './modules/instance/service'

const roots: string[] = []
const dbs: SqlDatabase[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'settings-import-'))
  roots.push(root)
  const db = openDatabase(':memory:')
  dbs.push(db)
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  return { root, db, path: join(root, 'config.json') }
}
function settings(db: SqlDatabase) {
  return JSON.parse(
    (db.prepare("SELECT value FROM meta WHERE key = 'settings'").get() as { value: string }).value,
  )
}
afterEach(() => {
  vi.unstubAllEnvs()
  for (const db of dbs.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('one-time config settings import', () => {
  it('moves populated UI settings, preserves bootstrap/operator/unknown fields, and never consumes later overrides', () => {
    const { root, db, path } = fixture()
    const config = {
      mode: 'server',
      port: 19991,
      publicUrl: 'https://podium.test',
      pairCode: 'kept',
      futureField: 'preserved',
      updateChannel: 'dev',
      auth: { openMode: true, mode: 'local' },
      transcriptLake: 'off',
      connect: { enabled: false, baseUrl: 'https://connect.test' },
      telemetry: {
        usage: 'on',
        crash: 'off',
        installId: '2b170e96-009a-4adb-8ff9-65dbf5b243fe',
        since: 123,
        endpoint: 'https://pulse.test',
      },
    }
    writeFileSync(path, JSON.stringify(config))
    importConfigSettings(db, root)
    expect(settings(db)).toMatchObject({
      deployment: {
        updateChannel: 'dev',
        authOpenMode: true,
        connectEnabled: false,
        telemetryUsage: 'on',
        telemetryInstallId: '2b170e96-009a-4adb-8ff9-65dbf5b243fe',
        telemetrySince: 123,
      },
      transcripts: { mirror: false },
    })
    // Only telemetry 'on' values are imported (POD-5922).
    expect(settings(db).deployment).not.toHaveProperty('telemetryCrash')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      mode: 'server',
      port: 19991,
      publicUrl: 'https://podium.test',
      pairCode: 'kept',
      futureField: 'preserved',
      auth: { mode: 'local' },
      connect: { baseUrl: 'https://connect.test' },
      telemetry: { endpoint: 'https://pulse.test' },
    })
    writeFileSync(path, JSON.stringify({ mode: 'server', updateChannel: 'edge' }))
    importConfigSettings(db, root)
    expect(settings(db).deployment.updateChannel).toBe('dev')
    expect(JSON.parse(readFileSync(path, 'utf8')).updateChannel).toBe('edge')
  })
  it('preserves existing table choices and personal preferences', () => {
    const { root, db, path } = fixture()
    db.prepare('INSERT INTO meta VALUES (?, ?)').run(
      'settings',
      JSON.stringify({ deployment: { updateChannel: 'stable' }, transcripts: { mirror: true } }),
    )
    db.exec(
      "CREATE TABLE user_preferences (user_id TEXT, value TEXT); INSERT INTO user_preferences VALUES ('member', 'untouched')",
    )
    writeFileSync(path, JSON.stringify({ updateChannel: 'edge', transcriptLake: 'off' }))
    importConfigSettings(db, root)
    expect(settings(db).deployment.updateChannel).toBe('stable')
    expect(settings(db).transcripts.mirror).toBe(true)
    expect(db.prepare('SELECT value FROM user_preferences').get()).toEqual({ value: 'untouched' })
  })
  it('resumes cleanup after a committed import without importing again', () => {
    const { root, db, path } = fixture()
    const raw = JSON.stringify({ updateChannel: 'edge', port: 19991 })
    writeFileSync(path, raw)
    db.prepare('INSERT INTO meta VALUES (?, ?)').run(
      'settings',
      JSON.stringify({ deployment: { updateChannel: 'dev' } }),
    )
    db.prepare('INSERT INTO meta VALUES (?, ?)').run(
      SETTINGS_CONFIG_IMPORT,
      JSON.stringify({ raw }),
    )
    importConfigSettings(db, root)
    expect(settings(db).deployment.updateChannel).toBe('dev')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ port: 19991 })
  })
  it('refuses malformed config without committing an import receipt', () => {
    const { root, db, path } = fixture()
    writeFileSync(path, '{broken')
    expect(() => importConfigSettings(db, root)).toThrow()
    expect(db.prepare('SELECT * FROM meta').all()).toEqual([])
  })
  it('UI writes reach the existing row and synchronous consumers, survive reopen, and leave the file unchanged', async () => {
    const { root, path } = fixture()
    const raw = JSON.stringify({ mode: 'server', port: 19991 })
    writeFileSync(path, raw)
    vi.stubEnv('PODIUM_STATE_DIR', root)
    let store = await openTestStore(join(root, 'podium.db'))
    try {
      const before = readFileSync(path, 'utf8')
      const service = new InstanceService({ settings: store.settings })
      await service.setChannel('edge')
      await service.setConsent({ usage: 'on', crash: 'off' })
      await store.settings.updateDeployment({ connectEnabled: false })
      expect(store.settings.resolve('updateChannel')).toEqual({ value: 'edge', source: 'settings' })
      expect(store.settings.resolve('connectEnabled')).toEqual({ value: false, source: 'settings' })
      expect(service.telemetryState()).toMatchObject({
        usage: 'on',
        crash: 'off',
        installId: expect.any(String),
      })
      expect(readFileSync(path, 'utf8')).toBe(before)
      await expect(
        store.transact(async () => {
          await store.settings.updateDeployment({ updateChannel: 'dev' })
          expect(store.settings.resolve('updateChannel').value).toBe('edge')
          throw new Error('rollback')
        }),
      ).rejects.toThrow('rollback')
      expect(store.settings.resolve('updateChannel').value).toBe('edge')
      expect((await store.settings.getSettings()).deployment.updateChannel).toBe('edge')
      const storedId = (await store.settings.getSettings()).deployment.telemetryInstallId
      writeFileSync(
        path,
        JSON.stringify({
          mode: 'server',
          telemetry: { installId: '2b170e96-009a-4adb-8ff9-65dbf5b243fe' },
        }),
      )
      forgetConfig(path)
      expect(service.provenance().telemetryInstallId).toEqual({ source: 'file' })
      await expect(service.resetInstallId()).rejects.toThrow(/config.json/)
      expect((await store.settings.getSettings()).deployment.telemetryInstallId).toBe(storedId)
      writeFileSync(path, before)
      forgetConfig(path)
      await store.close()
      store = await openTestStore(join(root, 'podium.db'))
      expect(store.settings.resolve('updateChannel')).toEqual({ value: 'edge', source: 'settings' })
      expect(store.settings.telemetryConfig().telemetry.usage).toBe('on')
    } finally {
      await store.close()
    }
  })
})

/**
 * POD-5922: the one-time import takes telemetry `on` values and the install
 * identity only. Later choices are never touched.
 */
describe('telemetry on the one-time import', () => {
  const ID = '2b170e96-009a-4adb-8ff9-65dbf5b243fe'

  it("imports 'on' and the identity only, and a second open changes nothing", () => {
    const { root, db, path } = fixture()
    writeFileSync(
      path,
      JSON.stringify({
        mode: 'server',
        telemetry: { usage: 'off', crash: 'on', installId: ID, since: 123 },
      }),
    )
    importConfigSettings(db, root)
    const imported = settings(db)
    expect(imported.deployment).not.toHaveProperty('telemetryUsage')
    expect(imported.deployment).toMatchObject({
      telemetryCrash: 'on',
      telemetryInstallId: ID,
      telemetrySince: 123,
    })
    // The cleanup still moves every telemetry choice out of config.json.
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ mode: 'server', telemetry: {} })

    // A later operator 'off' in config.json is an override, never re-imported.
    writeFileSync(path, JSON.stringify({ mode: 'server', telemetry: { usage: 'off' } }))
    importConfigSettings(db, root)
    expect(settings(db)).toEqual(imported)
  })

  it("an 'off' chosen after the import survives a restart", async () => {
    const { root, path } = fixture()
    writeFileSync(path, JSON.stringify({ mode: 'server', telemetry: { usage: 'off' } }))
    vi.stubEnv('PODIUM_STATE_DIR', root)
    vi.stubEnv('DO_NOT_TRACK', '')
    vi.stubEnv('PODIUM_TELEMETRY', '')
    let store = await openTestStore(join(root, 'podium.db'))
    try {
      forgetConfig(path)
      // No usage value was imported: usage takes its default.
      expect(store.settings.telemetryConfig().telemetry.usage).toBeUndefined()
      const service = new InstanceService({ settings: store.settings })
      expect(service.telemetryState().usage).toBe('absent')
      await service.setConsent({ usage: 'off' })
      await store.close()
      store = await openTestStore(join(root, 'podium.db'))
      forgetConfig(path)
      expect(store.settings.telemetryConfig().telemetry.usage).toBe('off')
      expect(new InstanceService({ settings: store.settings }).telemetryState().usage).toBe('off')
    } finally {
      await store.close()
    }
  })
})

/**
 * POD-5922: usage is on by default, so the server must mint the install id
 * itself — the emitter builds nothing without one — exactly once, and never
 * for a box with every tier off or a kill switch set.
 */
describe('ensureTelemetryIdentity', () => {
  const open = async (config: object, env: Record<string, string> = {}) => {
    const { root, path } = fixture()
    writeFileSync(path, JSON.stringify({ mode: 'server', ...config }))
    vi.stubEnv('PODIUM_STATE_DIR', root)
    vi.stubEnv('DO_NOT_TRACK', env.DO_NOT_TRACK ?? '')
    vi.stubEnv('PODIUM_TELEMETRY', env.PODIUM_TELEMETRY ?? '')
    forgetConfig(path)
    const store = await openTestStore(join(root, 'podium.db'))
    forgetConfig(path)
    return { root, path, store }
  }

  it('mints and persists an id once when usage is on by default', async () => {
    const { root, store } = await open({})
    let reopened: Awaited<ReturnType<typeof openTestStore>> | undefined
    try {
      expect(store.settings.telemetryConfig().telemetry.installId).toBeUndefined()
      expect(await store.settings.ensureTelemetryIdentity(1_700_000_000_000)).toBe(true)
      const { deployment } = await store.settings.getSettings()
      expect(deployment.telemetryInstallId).toMatch(/^[0-9a-f-]{36}$/)
      expect(deployment.telemetrySince).toBe(1_700_000_000_000)
      // Nothing about consent was written: usage stays "never chosen".
      expect(deployment.telemetryUsage).toBeUndefined()
      expect(await store.settings.ensureTelemetryIdentity()).toBe(false)
      await store.close()
      reopened = await openTestStore(join(root, 'podium.db'))
      expect(await reopened.settings.ensureTelemetryIdentity()).toBe(false)
      expect(reopened.settings.telemetryConfig().telemetry.installId).toBe(
        deployment.telemetryInstallId,
      )
    } finally {
      await (reopened ?? store).close()
    }
  })

  it('mints nothing while every tier is off', async () => {
    const { store } = await open({})
    try {
      await new InstanceService({ settings: store.settings }).setConsent({ usage: 'off' })
      expect(await store.settings.ensureTelemetryIdentity()).toBe(false)
      expect((await store.settings.getSettings()).deployment.telemetryInstallId).toBeUndefined()
    } finally {
      await store.close()
    }
  })

  it('mints nothing under a kill switch', async () => {
    const envs: Record<string, string>[] = [{ DO_NOT_TRACK: '1' }, { PODIUM_TELEMETRY: 'off' }]
    for (const env of envs) {
      const { store } = await open({}, env)
      try {
        expect(await store.settings.ensureTelemetryIdentity()).toBe(false)
        expect((await store.settings.getSettings()).deployment.telemetryInstallId).toBeUndefined()
      } finally {
        await store.close()
      }
    }
  })

  it('turning usage back on after an off mints through the consent write', async () => {
    const { store } = await open({})
    try {
      const service = new InstanceService({ settings: store.settings })
      await service.setConsent({ usage: 'off' })
      expect(service.telemetryState().installId).toBeUndefined()
      await service.setConsent({ usage: 'on' })
      expect(service.telemetryState().installId).toMatch(/^[0-9a-f-]{36}$/)
    } finally {
      await store.close()
    }
  })
})
