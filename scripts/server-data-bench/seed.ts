/**
 * Seed one arm's isolated state directory from an exported corpus (POD-6146).
 *
 * The rows are written through the ARM's own store (`--checkout`), so each arm gets a
 * database built by its own schema and repositories. The corpus itself comes from
 * `corpus-export.ts`, written once by the harness checkout, so both arms hold the same
 * facts. Nothing here touches a live instance: the database path must be inside a
 * bench root.
 *
 * Usage: bun --conditions=@podium/source scripts/server-data-bench/seed.ts
 *          --checkout=<arm checkout> --corpus=<corpus.json> --db=<state>/podium.db --out=<fixture.json>
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BenchCorpus } from './corpus-export'

/** Deterministic UUID-shaped id, so the same corpus always seeds the same ids. */
export function benchUuid(seed: number, kind: string, id: string): string {
  const hex = createHash('sha256').update(`${seed}:${kind}:${id}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Stable bucket in [0, n) for a corpus id. */
export function bucketOf(id: string, n: number): number {
  return createHash('sha256').update(id).digest().readUInt32BE(0) % n
}

export interface BenchFixture {
  cell: string
  seed: number
  machines: Array<{ id: string; name: string; token: string; liveSessionIds: string[]; sessionIds: string[] }>
  issueIds: string[]
  sessionIds: string[]
  counts: { issues: number; sessions: number; liveSessions: number; repos: number; deps: number; machines: number }
}

/** Every parent before its children (the parent column is a foreign key); seq order otherwise. */
export function parentsFirst<T extends { id: string; seq: number; parentId: string | null }>(issues: readonly T[]): T[] {
  const byId = new Map(issues.map((issue) => [issue.id, issue]))
  const out: T[] = []
  const placed = new Set<string>()
  const place = (issue: T, trail: Set<string>) => {
    if (placed.has(issue.id)) return
    const parent = issue.parentId ? byId.get(issue.parentId) : undefined
    if (parent && !trail.has(parent.id)) place(parent, new Set([...trail, issue.id]))
    placed.add(issue.id)
    out.push(issue)
  }
  for (const issue of [...issues].sort((a, b) => a.seq - b.seq)) place(issue, new Set())
  return out
}

const CLOSED_REASONS =new Set(['done', 'wontfix', 'duplicate', 'superseded', 'obsolete'])

async function seed(args: Record<string, string>): Promise<BenchFixture> {
  const checkout = args.checkout!
  const corpus = JSON.parse(readFileSync(args.corpus!, 'utf8')) as BenchCorpus
  const { SessionStore } = await import(join(checkout, 'apps/server/src/store.ts'))
  const model = await import(join(checkout, 'packages/model/src/index.ts'))
  const store = await SessionStore.open(args.db!)
  const owner = await model.firstAdminMemberId(store)
  model.primeFirstAdminMember(owner)
  // A fresh install mints its update signing key at first boot, before any machine
  // enrolls; a server that finds enrolled machines and no key refuses to start.
  const signingKey = join(checkout, 'packages/runtime/src/update-signing-key.ts')
  if (existsSync(signingKey)) (await import(signingKey)).readOrCreateUpdateSigningKey(dirname(args.db!))
  const issueId = (id: string) => `iss_${benchUuid(corpus.seed, 'issue', id)}`
  const machines = corpus.machines.map((machine, index) => ({
    id: benchUuid(corpus.seed, 'machine', machine.id),
    name: machine.name,
    hostname: machine.hostname,
    token: `bench-${corpus.cell}-${corpus.seed}-${index}`,
    liveSessionIds: [] as string[],
    sessionIds: [] as string[],
  }))
  const machineFor = (id: string) => machines[bucketOf(id, machines.length)]!
  let deps = 0
  await store.transact(async () => {
    for (const machine of machines) {
      await store.machines.upsertMachine({
        id: machine.id,
        name: machine.name,
        hostname: machine.hostname,
        tokenHash: createHash('sha256').update(machine.token).digest('hex'),
        ownerUserId: owner,
        assignment: { server: false, agentExecution: true },
      })
    }
    for (const [index, path] of corpus.repos.entries()) {
      await store.repos.addRepo(path, machines[index % machines.length]!.id)
    }
  })
  const issues = parentsFirst(corpus.issues)
  const known = new Set(issues.map((issue) => issue.id))
  const chunk = 500
  for (let start = 0; start < issues.length; start += chunk) {
    await store.transact(async () => {
      for (const issue of issues.slice(start, start + chunk)) {
        const closed = issue.stage === 'done' || issue.stage === 'cancelled'
        await store.issues.upsertIssue({
          id: issueId(issue.id),
          ownerUserId: owner,
          visibility: 'personal',
          createdByActor: owner,
          createdByOnBehalfOf: owner,
          repoPath: issue.repoPath ?? '/bench-unassigned',
          seq: issue.seq,
          title: issue.title,
          description: issue.description ?? '',
          stage: issue.stage,
          worktreePath: issue.worktreePath,
          branch: issue.branch,
          parentBranch: issue.parentBranch ?? 'main',
          defaultAgent: 'claude-code',
          defaultModel: 'auto',
          defaultEffort: 'auto',
          linearId: null, linearIdentifier: null, linearUrl: null,
          activityNotes: null, notesUpdatedAt: null, suggestedStage: null, suggestedReason: null,
          blockedBy: [], dependencyNote: null, prUrl: null,
          createdAt: issue.createdAt,
          updatedAt: issue.updatedAt,
          archived: issue.archived,
          priority: issue.priority,
          type: issue.type,
          assignee: null,
          parentId: issue.parentId && known.has(issue.parentId) ? issueId(issue.parentId) : null,
          design: null, acceptance: null, notes: null, dueAt: null,
          deferUntil: issue.deferUntil,
          closedReason: closed ? (CLOSED_REASONS.has(issue.closedReason ?? '') ? issue.closedReason : 'done') : null,
          closedAt: closed ? (issue.closedAt ?? issue.updatedAt) : null,
          supersededBy: null, duplicateOf: null, estimateMin: null,
          needsHuman: issue.needsHuman,
          humanQuestion: null,
        })
      }
    })
  }
  await store.transact(async () => {
    for (const dep of corpus.deps) {
      if (!known.has(dep.fromId) || !known.has(dep.toId)) continue
      await store.issues.addIssueDep(issueId(dep.fromId), issueId(dep.toId), dep.type)
      deps++
    }
  })
  const sessionIds: string[] = []
  for (let start = 0; start < corpus.sessions.length; start += chunk) {
    await store.transact(async () => {
      for (const session of corpus.sessions.slice(start, start + chunk)) {
        const id = benchUuid(corpus.seed, 'session', session.id)
        const machine = machineFor(session.id)
        machine.sessionIds.push(id)
        if (session.status === 'live') machine.liveSessionIds.push(id)
        sessionIds.push(id)
        await store.sessions.upsertSession({
          id,
          ownerUserId: owner,
          agentKind: session.agentKind,
          cwd: session.cwd,
          title: session.title,
          name: null,
          originKind: 'spawn',
          conversationId: null,
          resumeKind: session.resumeKind,
          resumeValue: session.resumeValue,
          status: session.status,
          exitCode: session.status === 'exited' ? 0 : null,
          durableLabel: `podium-${id}`,
          createdAt: session.createdAt,
          lastActiveAt: session.lastActiveAt,
          lastOutputAt: null,
          lastInputAt: null,
          lastResumedAt: null,
          archived: session.archived,
          workState: null,
          machineId: machine.id,
          headless: session.headless,
          issueId: session.issueId && known.has(session.issueId) ? issueId(session.issueId) : null,
          stoppedAt: session.stoppedAt,
        })
      }
    })
  }
  await store.close()
  return {
    cell: corpus.cell,
    seed: corpus.seed,
    machines: machines.map(({ id, name, token, liveSessionIds, sessionIds }) => ({ id, name, token, liveSessionIds, sessionIds })),
    issueIds: issues.map((issue) => issueId(issue.id)),
    sessionIds,
    counts: {
      issues: issues.length,
      sessions: sessionIds.length,
      liveSessions: machines.reduce((n, machine) => n + machine.liveSessionIds.length, 0),
      repos: corpus.repos.length,
      deps,
      machines: machines.length,
    },
  }
}

export function parseArgs(argv: readonly string[]): Record<string, string> {
  return Object.fromEntries(argv.filter((arg) => arg.startsWith('--')).map((arg) => {
    const at = arg.indexOf('=')
    return at < 0 ? [arg.slice(2), 'true'] : [arg.slice(2, at), arg.slice(at + 1)]
  }))
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2))
  for (const name of ['checkout', 'corpus', 'db', 'out']) if (!args[name]) throw new Error(`seed.ts: --${name} is required`)
  const fixture = await seed(args)
  writeFileSync(args.out!, JSON.stringify(fixture, null, 2))
  console.log(JSON.stringify(fixture.counts))
}
