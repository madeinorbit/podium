/** Shared, synthetic OLD corpus; only the wire spelling changes with the arm. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { buildCorpus, buildCorpusCell, cellLabel, parseCell } from '../../../tests/worklist/harness/src/fixture/index.ts'
import { FeedChange } from '@podium/protocol'

const arg = (key, fallback) => process.argv.find(x => x.startsWith(`--${key}=`))?.split('=').slice(1).join('=') ?? fallback
const scale = Number(arg('scale', '1'))
if (![1, 4].includes(scale)) throw Error('Use scale 1 or 4')
// POD-5594: `--cell=h10a1` grows history and active work separately (the
// startup corpus); `--scale` keeps the older together-grown 1x/4x corpus.
const cell = process.argv.some(x => x.startsWith('--cell=')) ? parseCell(arg('cell', '')) : null
const key = cell ? cellLabel(cell) : `${scale}x`
const seed = Number(arg('seed', '4443'))
const output = arg('out', '.artifacts/old-vs-new')
mkdirSync(output, { recursive: true })
const input = arg('source', '')
const generated = input ? JSON.parse(readFileSync(input, 'utf8')) : (cell ? buildCorpusCell(cell, seed) : buildCorpus(scale, seed))
const keys = ['issues', 'issueProjections', 'sessions', 'repoProjections', 'issueDeps', 'repos', 'machines', 'pins', 'fixedNow', 'stats', ...(cell ? ['cell', 'units'] : [])]
const corpus = Object.fromEntries(keys.map(key => [key, generated[key]]))
const semanticSha256 = createHash('sha256').update(JSON.stringify(corpus)).digest('hex')
writeFileSync(`${output}/corpus-${key}.json`, JSON.stringify(corpus))
let rows = []
if (existsSync('packages/client-graph')) {
  const { fixtureProjection } = await import('../../../tests/worklist/harness/src/fixture/normalized-issues.ts')
  const { seedAcceptanceCache } = await import('../test/sidebar-acceptance-seed.ts')
  corpus.issueProjections = corpus.issues.map((issue, index) => fixtureProjection(issue, corpus.issueProjections[index]))
  rows = seedAcceptanceCache(corpus, 'operator').readEntities().map(({ entity, entityId, value }) => ({ entity, entityId, value }))
} else {
  for (const [field, entity, id] of [['issues', 'issue', 'id'], ['issueProjections', 'issueProjection', 'id'], ['sessions', 'session', 'sessionId'], ['repoProjections', 'repo', 'id'], ['issueDeps', 'issueDep', 'id']]) {
    for (const raw of corpus[field]) {
      const value = entity === 'issue' ? { defaultAgent: 'auto', defaultModel: 'auto', defaultEffort: 'auto', ...raw } : raw
      rows.push({ entity, entityId: value[id], value })
    }
  }
}
// The historical git fixture specifies ahead/shared/merged only. Preserve those facts
// and supply the new record's required identity/timestamp and absent dirty count.
for (const row of rows) if (row.entity === 'issueGitState') {
  const issue = corpus.issues.find(issue => issue.id === row.entityId)
  row.value = { updatedAt: issue.updatedAt, branch: issue.branch ?? issue.parentBranch, dirtyFiles: 0, ...row.value }
}
const failures = []
rows = rows.map((row, index) => {
  let parsed = FeedChange.safeParse({ ...row, seq: index + 1, op: 'upsert' })
  if (!parsed.success) {
    // The local fixture spells absent optional strings as null; the wire omits them.
    const value = { ...row.value }
    for (const issue of parsed.error.issues) if (issue.code === 'invalid_type' && issue.received === 'null' && issue.expected === 'string' && issue.path.length === 2 && issue.path[0] === 'value') delete value[issue.path[1]]
    row = { ...row, value }
    parsed = FeedChange.safeParse({ ...row, seq: index + 1, op: 'upsert' })
  }
  if (!parsed.success) failures.push({ entity: row.entity, entityId: row.entityId, errors: parsed.error.issues })
  return parsed.success ? parsed.data : row
})
writeFileSync(`${output}/validation-${key}.json`, JSON.stringify(failures, null, 2))
if (failures.length) throw Error(`${failures.length} invalid fixture rows; see validation file. No capture permitted.`)
const rowBytes = JSON.stringify(rows)
writeFileSync(`${output}/rows-${key}.json`, rowBytes)
const rowsSha256 = createHash('sha256').update(rowBytes).digest('hex')
console.log(JSON.stringify({ corpus: key, seed, issues: corpus.issues.length, sessions: corpus.sessions.length, rows: rows.length, semanticSha256, rowsSha256 }))
