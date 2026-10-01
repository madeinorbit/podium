/**
 * POD-4552 — export an anonymised snapshot of a running Podium server and
 * compare its shape with the fixture at 1x.
 *
 *   bun packages/worklist-proto/harness/src/fixture/export-snapshot.ts
 *       [--origin http://127.0.0.1:18787] [--out <file.json.gz>]
 *   bun packages/worklist-proto/harness/src/fixture/export-snapshot.ts --compare <file.json.gz>
 *
 * READS WHAT THE WEB CLIENT READS, THE WAY IT READS IT. The kernel rows come
 * from `HttpBootstrapSource` (`@podium/client-core/sync-stream`), the class the
 * web replica bootstraps through; the machine scan and pins come from the two
 * `PodiumClientApi` calls the runtime makes at boot
 * (`discovery.refreshRepos.mutate()`, `pins.list.query()`), sent in tRPC's
 * `httpBatchLink` wire format. Auth is the web's: the `podium_session` cookie,
 * minted for the CLI in `~/.podium/cli-session.json`. The bootstrap is read
 * once, as one stream (the live corpus is ~5,000 issues).
 *
 * The export is written under `harness/.live/` (gitignored). It never leaves
 * ludovico and is never attached, committed or mailed. The hashing key is
 * random per run and never stored.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { PodiumClientApi } from '@podium/client-core/api'
import { HttpBootstrapSource } from '@podium/client-core/sync-stream'
import { expectedSnapshot } from '../oracle/index'
import { buildCorpus } from './index'
import {
  anonymisationParity,
  anonymiseCollections,
  corpusFromLive,
  Hasher,
  LIVE_SNAPSHOT_FORMAT,
  type LiveCollections,
  type LiveSnapshot,
} from './live-snapshot'
import {
  assertPrefixFidelity,
  compareShapes,
  measureShape,
  prefixFidelity,
  renderComparison,
} from './shape'

const DEFAULT_ORIGIN = 'http://127.0.0.1:18787'
const HERE = dirname(new URL(import.meta.url).pathname)
const LIVE_DIR = resolve(HERE, '../../.live')

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}

function sessionToken(): string {
  const file = arg('--token-file') ?? join(homedir(), '.podium', 'cli-session.json')
  const { token, expiresAt } = JSON.parse(readFileSync(file, 'utf8')) as {
    token: string
    expiresAt?: string
  }
  if (expiresAt !== undefined && Date.parse(expiresAt) < Date.now())
    throw new Error(
      `${file}: the CLI session expired at ${expiresAt}; run any \`podium\` command to refresh it`,
    )
  return token
}

/** The two boot calls, as `PodiumClientApi` members, over the batch wire format. */
function clientApi(
  origin: string,
  cookie: string,
): {
  discovery: Pick<PodiumClientApi['discovery'], 'refreshRepos'>
  pins: Pick<PodiumClientApi['pins'], 'list'>
} {
  const call = async <O>(path: string, method: 'GET' | 'POST'): Promise<O> => {
    const url =
      method === 'GET'
        ? `${origin}/trpc/${path}?batch=1&input=${encodeURIComponent('{}')}`
        : `${origin}/trpc/${path}?batch=1`
    const response = await fetch(url, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: '{}' } : {}),
    })
    const body = (await response.json()) as Array<{
      result?: { data: O }
      error?: { message: string }
    }>
    const first = body[0]
    if (!response.ok || first?.result === undefined)
      throw new Error(`${path}: HTTP ${response.status} ${first?.error?.message ?? ''}`)
    return first.result.data
  }
  return {
    discovery: { refreshRepos: { mutate: () => call('discovery.refreshRepos', 'POST') } },
    pins: { list: { query: () => call('pins.list', 'GET') } },
  }
}

const EXPORTED_ENTITIES: Record<string, keyof LiveCollections> = {
  issue: 'issues',
  issueProjection: 'issueProjections',
  session: 'sessions',
  repo: 'repoProjections',
  issueDep: 'issueDeps',
}

export async function readLive(origin: string): Promise<{
  raw: LiveCollections
  snapshotSeq: number
  bootstrapEntityCounts: Record<string, number>
}> {
  const cookie = `podium_session=${sessionToken()}`
  const source = new HttpBootstrapSource({
    origin,
    streamingFetch: {
      fetch: (input, init) =>
        fetch(input, { ...init, headers: { ...(init.headers as object), cookie } }),
    },
  })
  const byEntity = new Map<string, Map<string, unknown>>()
  const bootstrapEntityCounts: Record<string, number> = {}
  let snapshotSeq = 0
  for await (const chunk of source.bootstrap()) {
    for (const change of chunk.changes) {
      bootstrapEntityCounts[change.entity] = (bootstrapEntityCounts[change.entity] ?? 0) + 1
      if (!(change.entity in EXPORTED_ENTITIES)) continue
      const rows = byEntity.get(change.entity) ?? new Map<string, unknown>()
      byEntity.set(change.entity, rows)
      if (change.op === 'upsert') rows.set(change.entityId, change.payload)
      else rows.delete(change.entityId)
    }
    if (chunk.last) snapshotSeq = chunk.snapshotSeq
  }
  const rowsOf = <T>(entity: string): T[] => [...(byEntity.get(entity)?.values() ?? [])] as T[]
  const api = clientApi(origin, cookie)
  const scan = await api.discovery.refreshRepos.mutate()
  const pins = await api.pins.list.query()
  return {
    raw: {
      issues: rowsOf('issue'),
      issueProjections: rowsOf('issueProjection'),
      sessions: rowsOf('session'),
      repoProjections: rowsOf('repo'),
      issueDeps: rowsOf('issueDep'),
      repos: scan.repositories,
      machines: scan.machines,
      pins,
    },
    snapshotSeq,
    bootstrapEntityCounts,
  }
}

export function readSnapshot(file: string): LiveSnapshot {
  const snapshot = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as LiveSnapshot
  if (snapshot.format !== LIVE_SNAPSHOT_FORMAT)
    throw new Error(`${file}: not a ${LIVE_SNAPSHOT_FORMAT} file`)
  return snapshot
}

/** Fixture 1x vs live: the markdown table plus both measure sets. */
export function compareWithFixture(snapshot: LiveSnapshot) {
  const fixture = measureShape(buildCorpus(1, 4443))
  const liveCorpus = corpusFromLive(snapshot, Date.parse(snapshot.exportedAt))
  assertPrefixFidelity(
    prefixFidelity(
      liveCorpus,
      expectedSnapshot(liveCorpus, { selectedIssueId: null, coarseNow: liveCorpus.fixedNow }),
    ),
  )
  const live = measureShape(liveCorpus)
  const rows = compareShapes(fixture, live)
  return { fixture, live, rows, table: renderComparison(rows, fixture, live) }
}

async function main(): Promise<void> {
  const compareFile = arg('--compare')
  if (compareFile !== undefined) {
    const { fixture, live, rows, table } = compareWithFixture(readSnapshot(compareFile))
    console.log(table)
    console.log(
      `\nfollow-ups (> 20%): ${rows
        .filter((r) => r.followUp)
        .map((r) => r.measure)
        .join('; ')}`,
    )
    writeFileSync(
      `${compareFile}.shape.json`,
      `${JSON.stringify({ fixture, live, rows }, null, 2)}\n`,
    )
    return
  }
  const origin = (arg('--origin') ?? process.env.PODIUM_ORIGIN ?? DEFAULT_ORIGIN).replace(/\/$/, '')
  const exportedAt = new Date().toISOString()
  const { raw, snapshotSeq, bootstrapEntityCounts } = await readLive(origin)
  const hasher = new Hasher()
  const anonymised = anonymiseCollections(raw, hasher)
  const parity = anonymisationParity(raw, anonymised, Date.parse(exportedAt))
  if (!parity.equalExceptTitles)
    throw new Error(
      `anonymisation changed the oracle snapshot (${parity.differingRows.length} rows: ${parity.differingRows.slice(0, 5).join(', ')}); a hashed field is read by the derivation — add it to KEEP_KEYS`,
    )
  // The repo rows must survive the export, or every POD-123 label reads #123
  // and the label comparison is vacuous (POD-4624).
  const now = Date.parse(exportedAt)
  const hashedCorpus = corpusFromLive(anonymised, now)
  assertPrefixFidelity(
    prefixFidelity(
      hashedCorpus,
      expectedSnapshot(hashedCorpus, { selectedIssueId: null, coarseNow: now }),
    ),
  )
  const snapshot: LiveSnapshot = {
    format: LIVE_SNAPSHOT_FORMAT,
    exportedAt,
    snapshotSeq,
    bootstrapEntityCounts,
    ...anonymised,
    anonymisation: { ...hasher.counts, keptKeys: [...hasher.keptKeys].sort(), parity },
  }
  const out = arg('--out') ?? join(LIVE_DIR, `live-snapshot-${exportedAt.slice(0, 10)}.json.gz`)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, gzipSync(JSON.stringify(snapshot)))
  console.log(
    `wrote ${out}: ${raw.issues.length} issues, ${raw.sessions.length} sessions, ${raw.repoProjections.length} repo prefixes, ${raw.repos.length} scan repos, ${raw.issueDeps.length} deps; seq ${snapshotSeq}; parity ${parity.rawVisibleRows} = ${parity.anonymisedVisibleRows} visible rows`,
  )
}

if (import.meta.main) await main()
