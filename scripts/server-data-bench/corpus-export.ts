/**
 * Write one `buildCorpusCell` cell (POD-4747) as plain JSON for the seeder (POD-6146).
 *
 * Runs in the HARNESS checkout, so both arms of an A/B are seeded from byte-identical
 * corpus data even when one arm's corpus builder differs. The seeder runs in each ARM's
 * checkout and only reads this file.
 *
 * Usage: bun --conditions=@podium/source scripts/server-data-bench/corpus-export.ts <cell> <seed> <out.json>
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Loaded by computed path at runtime: the corpus module's client-graph imports belong to the
 *  worklist harness's typecheck, not this package's. `BenchCorpus` below types what we use. */
const CORPUS_MODULE = fileURLToPath(new URL('../../tests/worklist/harness/src/fixture/corpus.ts', import.meta.url))

export interface BenchCorpus {
  cell: string
  seed: number
  issues: Array<{
    id: string; seq: number; title: string; description: string | null; stage: string
    parentId: string | null; repoPath: string | null; worktreePath: string | null; branch: string | null
    parentBranch: string | null; priority: number; type: string; archived: boolean; needsHuman: boolean
    createdAt: string; updatedAt: string; closedAt: string | null; closedReason: string | null
    deferUntil: string | null; deletedAt: string | null
  }>
  deps: Array<{ fromId: string; toId: string; type: string }>
  sessions: Array<{
    id: string; agentKind: string; title: string; cwd: string; status: string; archived: boolean
    createdAt: string; lastActiveAt: string; issueId: string | null; headless: boolean
    resumeKind: string | null; resumeValue: string | null; stoppedAt: string | null
  }>
  repos: string[]
  machines: Array<{ id: string; name: string; hostname: string }>
}

// biome-ignore lint/suspicious/noExplicitAny: the corpus module is loaded untyped on purpose (see CORPUS_MODULE).
type Untyped = any

export async function exportCorpus(cellLabel: string, seed: number): Promise<BenchCorpus> {
  const { buildCorpusCell, parseCell } = await import(CORPUS_MODULE)
  const corpus: Untyped = buildCorpusCell(parseCell(cellLabel), seed)
  const slices = new Map<string, Untyped>(corpus.sliceIssues.map((issue: Untyped) => [issue.id, issue]))
  const sliceSessions = new Map<string, Untyped>(corpus.sliceSessions.map((session: Untyped) => [session.sessionId, session]))
  return {
    cell: cellLabel,
    seed,
    issues: corpus.issues.map((issue: Untyped) => {
      const slice = slices.get(issue.id)
      return {
        id: issue.id,
        seq: issue.seq,
        title: issue.title,
        description: issue.description ?? null,
        stage: issue.stage,
        parentId: slice?.parentId ?? issue.parentId ?? null,
        repoPath: issue.repoPath ?? null,
        worktreePath: issue.worktreePath ?? null,
        branch: issue.branch ?? null,
        parentBranch: issue.parentBranch ?? null,
        priority: issue.priority ?? 2,
        type: issue.type ?? 'task',
        archived: issue.archived ?? false,
        needsHuman: issue.needsHuman ?? false,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        closedAt: issue.closedAt ?? null,
        closedReason: issue.closedReason ?? null,
        deferUntil: issue.deferUntil ?? null,
        deletedAt: slice?.deletedAt ?? null,
      }
    }),
    deps: corpus.issueDeps.map((dep: Untyped) => ({ fromId: dep.fromId, toId: dep.toId, type: dep.type })),
    sessions: corpus.sessions.map((session: Untyped) => ({
      id: session.sessionId,
      agentKind: session.agentKind,
      title: session.title,
      cwd: session.cwd,
      status: session.status,
      archived: session.archived ?? false,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      issueId: session.issueId ?? null,
      headless: sliceSessions.get(session.sessionId)?.headless ?? false,
      resumeKind: session.resume?.kind ?? null,
      resumeValue: session.resume?.value ?? null,
      stoppedAt: sliceSessions.get(session.sessionId)?.stoppedAt ?? null,
    })),
    repos: corpus.repos.map((repo: Untyped) => repo.path),
    machines: corpus.machines.map((machine: Untyped) => ({ id: machine.id, name: machine.name, hostname: machine.hostname })),
  }
}

if (import.meta.main) {
  const [cell, seed, out] = process.argv.slice(2)
  if (!cell || !seed || !out) throw new Error('usage: corpus-export.ts <cell> <seed> <out.json>')
  const corpus = await exportCorpus(cell, Number(seed))
  writeFileSync(out, JSON.stringify(corpus))
  console.log(JSON.stringify({ cell, seed: Number(seed), issues: corpus.issues.length, sessions: corpus.sessions.length, repos: corpus.repos.length, machines: corpus.machines.length }))
}
