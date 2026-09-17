import { readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { PodiumConfig } from '@podium/runtime/config'
import { PodiumSettings } from '@podium/runtime'
import type { SqlDatabase } from '@podium/runtime/sqlite'

export const SETTINGS_CONFIG_IMPORT = 'settings_config_import_v1'

/** Exclusive migration lane only. The receipt and imported settings commit together.
 * Cleanup resumes from that receipt; later operator overrides are never imported. */
export function importConfigSettings(db: SqlDatabase, directory?: string): void {
  const read = (key: string) =>
    (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)
      ?.value
  if (read(SETTINGS_CONFIG_IMPORT) === 'complete') return
  const path = directory === undefined ? undefined : join(directory, 'config.json')
  let raw: string | undefined
  if (path) {
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const config = raw === undefined ? {} : JSON.parse(raw)
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('config.json must contain an object')
  if (read(SETTINGS_CONFIG_IMPORT) === undefined) {
    PodiumConfig.parse(config)
    const stored = JSON.parse(read('settings') ?? '{}')
    const deployment = { ...stored.deployment }
    const values = {
      authOpenMode: config.auth?.openMode,
      updateChannel: config.updateChannel,
      connectEnabled: config.connect?.enabled,
      telemetryUsage: config.telemetry?.usage,
      telemetryCrash: config.telemetry?.crash,
      telemetryInstallId: config.telemetry?.installId,
      telemetrySince: config.telemetry?.since,
    }
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined && deployment[key] === undefined) deployment[key] = value
    }
    const transcripts = { ...stored.transcripts }
    if (config.transcriptLake !== undefined && transcripts.mirror === undefined)
      transcripts.mirror = config.transcriptLake === 'on'
    const next = { ...stored, deployment, transcripts }
    PodiumSettings.parse(next)
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run('settings', JSON.stringify(next))
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
        SETTINGS_CONFIG_IMPORT,
        raw === undefined ? 'complete' : JSON.stringify({ raw }),
      )
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  const receipt = read(SETTINGS_CONFIG_IMPORT)!
  if (receipt === 'complete') return
  const original = JSON.parse(receipt).raw as string
  const cleaned = JSON.parse(original)
  if (cleaned.auth) delete cleaned.auth.openMode
  delete cleaned.updateChannel
  delete cleaned.transcriptLake
  if (cleaned.connect) delete cleaned.connect.enabled
  if (cleaned.telemetry)
    for (const key of ['usage', 'crash', 'installId', 'since']) delete cleaned.telemetry[key]
  const output = JSON.stringify(cleaned, null, 2) + '\n'
  // Refuse concurrent operator edits; a retry must never erase a newly added override.
  if (raw !== original && raw !== output)
    throw new Error(
      'config.json changed during settings migration; finish the pending migration before editing overrides',
    )
  if (path && raw !== output) {
    const temporary = path + '.settings-migration.tmp'
    writeFileSync(temporary, output, { mode: 0o600 })
    const fd = openSync(temporary, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, path)
    const dir = openSync(directory!, 'r')
    try {
      fsyncSync(dir)
    } finally {
      closeSync(dir)
    }
  }
  db.prepare('UPDATE meta SET value = ? WHERE key = ?').run('complete', SETTINGS_CONFIG_IMPORT)
}
