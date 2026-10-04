/** Shared, synthetic OLD corpus; only the wire spelling changes with the arm. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { buildCorpus } from '../../../packages/worklist-proto/harness/src/fixture/index.ts'
import { FeedChange } from '@podium/protocol'

const arg = (key, fallback) => process.argv.find(x => x.startsWith(`--${key}=`))?.split('=').slice(1).join('=') ?? fallback
const scale = Number(arg('scale', '1'))
if (![1, 4].includes(scale)) throw Error('Use scale 1 or 4')
const output = arg('out', '.artifacts/old-vs-new')
mkdirSync(output, { recursive: true })
const input = arg('source', '')
const generated = input ? JSON.parse(readFileSync(input, 'utf8')) : buildCorpus(scale, 4443)
const keys = ['issues', 'issueProjections', 'sessions', 'repoProjections', 'issueDeps', 'repos', 'machines', 'pins', 'fixedNow', 'stats']
const corpus = Object.fromEntries(keys.map(key => [key, generated[key]]))
const semanticSha256 = createHash('sha256').update(JSON.stringify(corpus)).digest('hex')
writeFileSync(`${output}/corpus-${scale}x.json`, JSON.stringify(corpus))
let rows = []
if (existsSync('packages/client-graph')) {
  const { fixtureProjection } = await import('../../../packages/worklist-proto/harness/src/fixture/normalized-issues.ts')
  const { seedAcceptanceCache } = await import('../test/sidebar-acceptance-seed.ts')
  corpus.issueProjections = corpus.issues.map((issue, index) => fixtureProjection(issue, corpus.issueProjections[index]))
  rows = seedAcceptanceCache(corpus, 'operator').readEntities().map(({ entity, entityId, value }) => ({ entity, entityId, value }))
} else {
  for (const [field, entity, id] of [['issues', 'issue', 'id'], ['issueProjections', 'issueProjection', 'id'], ['sessions', 'session', 'sessionId'], ['repoProjections', 'repo', 'id'], ['issueDeps', 'issueDep', 'id']]) {
    for (const value of corpus[field]) rows.push({ entity, entityId: value[id], value })
  }
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
writeFileSync(`${output}/validation-${scale}x.json`, JSON.stringify(failures, null, 2))
if (failures.length) throw Error(`${failures.length} invalid fixture rows; see validation file. No capture permitted.`)
writeFileSync(`${output}/rows-${scale}x.json`, JSON.stringify(rows))
console.log(JSON.stringify({ scale, issues: corpus.issues.length, sessions: corpus.sessions.length, rows: rows.length, semanticSha256 }))
