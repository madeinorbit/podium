/** Measure the proposed feed row cap with slim records from a stopped bench arm. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CHANGE_KEEP_ROWS, CHANGE_MAX_AGE_MS } from '@podium/protocol'
import { openDatabase } from '@podium/runtime/sqlite'

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...value] = arg.replace(/^--/, '').split('=')
    return [key!, value.join('=')]
  }),
)
const input = resolve(args.get('db') ?? '')
if (!input.includes('/server-data-bench/'))
  throw new Error('--db must be a stopped server-data-bench arm')
const source = openDatabase(input, { readOnly: true })
const root = mkdtempSync(join(input.slice(0, input.lastIndexOf('/')), 'retention-disk-'))
const output = openDatabase(join(root, 'retention.db'))
try {
  const sample = source
    .prepare(`SELECT entity, entity_id, op, payload, origin_id, causation_id, mutation_id
    FROM changes ORDER BY seq DESC LIMIT 10000`)
    .all() as {
    entity: string
    entity_id: string
    op: string
    payload: string | null
    origin_id: string | null
    causation_id: string | null
    mutation_id: string | null
  }[]
  if (sample.length === 0) throw new Error('bench arm has no changes to sample')
  output.exec(`CREATE TABLE changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, entity_id TEXT NOT NULL,
    op TEXT NOT NULL, payload TEXT, event_time INTEGER NOT NULL,
    origin_id TEXT, causation_id TEXT, mutation_id TEXT);
    CREATE INDEX changes_entity ON changes(entity, entity_id, seq);
    CREATE INDEX changes_event_time ON changes(event_time);`)
  const bytes = () =>
    Number((output.prepare('PRAGMA page_count').get() as { page_count: number }).page_count) *
    Number((output.prepare('PRAGMA page_size').get() as { page_size: number }).page_size)
  const emptyBytes = bytes()
  const insert = output.prepare(
    'INSERT INTO changes (entity, entity_id, op, payload, event_time, origin_id, causation_id, mutation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  output.exec('BEGIN')
  for (let index = 0; index < CHANGE_KEEP_ROWS; index++) {
    const row = sample[index % sample.length]!
    insert.run(
      row.entity,
      row.entity_id,
      row.op,
      row.payload,
      Math.floor(Date.now() - CHANGE_MAX_AGE_MS + (index * CHANGE_MAX_AGE_MS) / CHANGE_KEEP_ROWS),
      row.origin_id,
      row.causation_id,
      row.mutation_id,
    )
  }
  output.exec('COMMIT; VACUUM')
  const fileBytes = bytes()
  const allocatedPerRow = (fileBytes - emptyBytes) / CHANGE_KEEP_ROWS
  // Chosen design's measured quiet-field/slim-record workload: 4,600 rows in 7.1 h.
  const designRowsPerDay = (4_600 / 7.1) * 24
  const ageWindowRows = Math.ceil((designRowsPerDay * CHANGE_MAX_AGE_MS) / 86_400_000)
  const report = {
    at: new Date().toISOString(),
    sampleRows: sample.length,
    samplePayloadBytes: sample.reduce((sum, row) => sum + Buffer.byteLength(row.payload ?? ''), 0),
    keepRows: CHANGE_KEEP_ROWS,
    maxAgeDays: CHANGE_MAX_AGE_MS / 86_400_000,
    emptyBytes,
    fileBytes,
    allocatedPerRow,
    designRowsPerDay,
    projectedAgeWindowRows: ageWindowRows,
    projectedAgeWindowBytes: Math.round(
      emptyBytes + Math.min(ageWindowRows, CHANGE_KEEP_ROWS) * allocatedPerRow,
    ),
    capReachDaysAtDesignRate: CHANGE_KEEP_ROWS / designRowsPerDay,
    sampleByKind: Object.fromEntries(
      [...new Set(sample.map((row) => row.entity))]
        .sort()
        .map((entity) => [entity, sample.filter((row) => row.entity === entity).length]),
    ),
  }
  const json = `${JSON.stringify(report, null, 2)}\n`
  if (args.has('out')) writeFileSync(args.get('out')!, json)
  process.stdout.write(json)
} finally {
  output.close()
  source.close()
  rmSync(root, { recursive: true, force: true })
}
