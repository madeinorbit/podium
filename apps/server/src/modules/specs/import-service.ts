import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { TRPCError } from '@trpc/server'
import type { ConversationSummaryWire, TranscriptItem } from '@podium/protocol'
import { z } from 'zod'
import type { LlmClient } from '../../llm'
import { getSpec, listSpecs, type SpecComponent } from '../../pspec'
import {
  addWorktree,
  branchCommitCount,
  branchExists,
  removeWorktree,
} from '../../pspec-git'
import { batchDigests, distillTranscript } from '../../pspec-import-distill'
import {
  applyImportOps,
  commitSpecTree,
  importAgentPlaybook,
  MAP_SYSTEM_PROMPT,
  mapUserPrompt,
  parseJsonReply,
  REDUCE_SYSTEM_PROMPT,
  reduceUserPrompt,
  type SpecFact,
  type SpecImportOp,
} from '../../pspec-import'
import { isAllowedRoot } from '../../root-allowlist'

/**
 * `podium spec import` (#172) — bootstrap/refresh the spec from past sessions.
 *
 * Agent-led by design: the pipeline PREPARES compact artifacts deterministically
 * and with cheap LLM calls (distill transcripts → decision digests → candidate
 * facts), then hands the whole task to a real harness agent in an ISOLATED
 * worktree on the import branch. The agent follows a structured playbook
 * (pspec-import.ts): verify facts against the actual codebase (fanning out to
 * fast-model subagents), resolve superseded decisions, structure the tree,
 * write pspec/ files, self-review, commit. Correctness needs code navigation —
 * a chat completion can't check whether a recorded decision still holds.
 *
 * Modes: 'agent' (default when an agent runner is wired), 'llm' (single-shot
 * reduce via the chat backend — no codebase verification), 'prepare' (artifacts
 * only, no writes — for driving the agent phase by hand).
 *
 * Rerunnable: a per-repo state file records each processed conversation (stable
 * podium id) with the transcript size it was processed at; reruns pick up only
 * new sessions and grown transcripts. Canon (the repo root checkout) is never
 * written — review happens in the specs branch-diff view.
 */

export const specImportInputs = {
  start: z.object({
    repoPath: z.string().min(1),
    mode: z.enum(['agent', 'llm', 'prepare']).optional(),
  }),
  status: z.object({ repoPath: z.string().min(1) }),
} as const

export interface SpecImportStatus {
  phase:
    | 'idle'
    | 'distilling'
    | 'mapping'
    | 'agent'
    | 'reducing'
    | 'committing'
    | 'done'
    | 'error'
  startedAt?: number
  finishedAt?: number
  /** Conversations distilled this run / discovered as new. */
  processed?: number
  total?: number
  facts?: number
  applied?: number
  skipped?: string[]
  branch?: string
  error?: string
  message?: string
}

interface ImportStateFile {
  /** conversation key → transcript byte size at processing time */
  processed: Record<string, number>
}

/** One full agent run in `cwd` (an isolated worktree). Resolves when the agent
 *  finishes its turn; `ok: false` carries the harness error. */
export type SpecImportAgentRunner = (input: {
  cwd: string
  prompt: string
  title: string
  timeoutMs: number
}) => Promise<{ ok: boolean; error?: string; output?: string }>

export interface SpecImportDeps {
  repoRoots: () => string[]
  /** All conversations the server knows for this repo (any agent, any machine). */
  conversationsFor: (repoPath: string) => ConversationSummaryWire[]
  /** Full transcript read for one conversation; null when unavailable. */
  readItems: (conv: ConversationSummaryWire) => Promise<TranscriptItem[] | null>
  /** Chat client from the configured backend — the CHEAP bulk phase (map) and
   *  the 'llm' fallback mode. Throws LlmConfigError when unset. */
  llm: () => LlmClient
  /** Harness agent runner for the main import phase; absent = 'llm' mode only. */
  agent?: SpecImportAgentRunner
  /** $PODIUM_STATE_DIR/spec-import */
  stateDir: () => string
  now?: () => number
}

const AGENT_TIMEOUT_MS = 45 * 60_000

function convKey(c: ConversationSummaryWire): string {
  return c.podiumId ?? `${c.agentKind}:${c.id}`
}

export class SpecImportService {
  private readonly running = new Map<string, SpecImportStatus>()

  constructor(private readonly deps: SpecImportDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private repoDir(repoPath: string): string {
    // Repo path → dirname: stable and filesystem-safe.
    const slug = repoPath.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')
    return join(this.deps.stateDir(), slug)
  }

  private loadState(repoPath: string): ImportStateFile {
    try {
      return JSON.parse(
        readFileSync(join(this.repoDir(repoPath), 'state.json'), 'utf8'),
      ) as ImportStateFile
    } catch {
      return { processed: {} }
    }
  }

  private saveState(repoPath: string, state: ImportStateFile): void {
    mkdirSync(this.repoDir(repoPath), { recursive: true })
    writeFileSync(join(this.repoDir(repoPath), 'state.json'), JSON.stringify(state, null, 1), 'utf8')
  }

  status(input: { repoPath: string }): SpecImportStatus {
    return this.running.get(input.repoPath) ?? { phase: 'idle' }
  }

  /** Kick off an import run; returns immediately. Poll `status`. */
  start(input: { repoPath: string; mode?: 'agent' | 'llm' | 'prepare' }): SpecImportStatus {
    const { repoPath } = input
    if (!isAllowedRoot(this.deps.repoRoots(), repoPath)) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'root is not a known repository path' })
    }
    const current = this.running.get(repoPath)
    if (current && !['idle', 'done', 'error'].includes(current.phase)) {
      throw new TRPCError({ code: 'CONFLICT', message: 'an import is already running for this repo' })
    }
    const mode = input.mode ?? (this.deps.agent ? 'agent' : 'llm')
    if (mode === 'agent' && !this.deps.agent) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'no agent runner available on this server — use mode "llm" or "prepare"',
      })
    }
    const llm = this.deps.llm() // fail fast on missing backend/key, before going async
    const status: SpecImportStatus = { phase: 'distilling', startedAt: this.now() }
    this.running.set(repoPath, status)
    void this.run(repoPath, mode, llm, status).catch((err: unknown) => {
      status.phase = 'error'
      status.error = err instanceof Error ? err.message : String(err)
      status.finishedAt = this.now()
    })
    return status
  }

  /** Distill new transcripts + extract candidate facts; persist both as files
   *  the agent (or a human) can read. Does not touch the repo. */
  private async prepare(
    repoPath: string,
    llm: LlmClient,
    state: ImportStateFile,
    status: SpecImportStatus,
  ): Promise<{ digestDir: string; factsPath: string; digests: number; facts: SpecFact[] }> {
    const dir = this.repoDir(repoPath)
    const digestDir = join(dir, 'digests')
    mkdirSync(digestDir, { recursive: true })

    const conversations = this.deps.conversationsFor(repoPath)
    const pending = conversations.filter((c) => {
      const seen = state.processed[convKey(c)]
      return seen === undefined || (c.sizeBytes !== undefined && c.sizeBytes > seen)
    })
    status.total = pending.length
    status.processed = 0

    const digests: string[] = []
    for (const conv of pending) {
      const items = await this.deps.readItems(conv)
      status.processed = (status.processed ?? 0) + 1
      state.processed[convKey(conv)] = conv.sizeBytes ?? 0
      if (!items || items.length === 0) continue
      const digest = distillTranscript(items, {
        conversationId: convKey(conv),
        agentKind: conv.agentKind,
        date: conv.updatedAt ?? conv.createdAt,
        branch: conv.git?.branch,
        title: conv.title,
      })
      if (!digest) continue
      digests.push(digest)
      writeFileSync(
        join(digestDir, `${convKey(conv).replace(/[^a-zA-Z0-9_-]+/g, '-')}.md`),
        digest,
        'utf8',
      )
    }

    status.phase = 'mapping'
    const facts: SpecFact[] = []
    for (const batch of batchDigests(digests)) {
      const reply = await llm.complete(
        [
          { role: 'system', content: MAP_SYSTEM_PROMPT },
          { role: 'user', content: mapUserPrompt(batch) },
        ],
        [],
      )
      facts.push(...(parseJsonReply<SpecFact[]>(reply.text) ?? []))
    }
    status.facts = facts.length
    const factsPath = join(dir, 'facts.json')
    writeFileSync(factsPath, JSON.stringify(facts, null, 1), 'utf8')
    return { digestDir, factsPath, digests: digests.length, facts }
  }

  private async run(
    repoPath: string,
    mode: 'agent' | 'llm' | 'prepare',
    llm: LlmClient,
    status: SpecImportStatus,
  ): Promise<void> {
    const state = this.loadState(repoPath)
    const prepared = await this.prepare(repoPath, llm, state, status)

    if (prepared.digests === 0) {
      this.saveState(repoPath, state)
      status.phase = 'done'
      status.message = 'no new sessions with importable decisions'
      status.finishedAt = this.now()
      return
    }
    if (mode === 'prepare' || prepared.facts.length === 0) {
      this.saveState(repoPath, state)
      status.phase = 'done'
      status.message =
        mode === 'prepare'
          ? `prepared ${prepared.facts.length} fact(s) from ${prepared.digests} session(s) at ${prepared.factsPath}`
          : 'sessions contained no explicit human decisions'
      status.finishedAt = this.now()
      return
    }

    const date = new Date(this.now()).toISOString().slice(0, 10)
    // update-ref/worktree-add would reuse an existing branch — pick a fresh name.
    let branch = `spec-import/${date}`
    for (let n = 2; await branchExists(repoPath, branch); n++) {
      branch = `spec-import/${date}-${n}`
    }

    if (mode === 'agent') {
      await this.runAgent(repoPath, branch, prepared, status)
    } else {
      await this.runLlmReduce(repoPath, branch, prepared.facts, prepared.digests, status)
    }
    this.saveState(repoPath, state)
    status.branch = branch
    status.phase = 'done'
    status.finishedAt = this.now()
  }

  /** The main path: a real agent, in an isolated worktree on the import branch,
   *  executing the structured playbook (verify → resolve → write → commit). */
  private async runAgent(
    repoPath: string,
    branch: string,
    prepared: { digestDir: string; factsPath: string; digests: number; facts: SpecFact[] },
    status: SpecImportStatus,
  ): Promise<void> {
    const agent = this.deps.agent
    if (!agent) throw new Error('agent runner unavailable')
    status.phase = 'agent'
    const worktree = join(this.repoDir(repoPath), 'worktree')
    await addWorktree(repoPath, worktree, branch)
    try {
      const prompt = importAgentPlaybook({
        repoName: basename(repoPath),
        branch,
        factsPath: prepared.factsPath,
        digestDir: prepared.digestDir,
        factCount: prepared.facts.length,
        sessionCount: prepared.digests,
      })
      const result = await agent({
        cwd: worktree,
        prompt,
        title: `spec import: ${basename(repoPath)}`,
        timeoutMs: AGENT_TIMEOUT_MS,
      })
      if (!result.ok) throw new Error(`import agent failed: ${result.error ?? 'unknown error'}`)
      const commits = await branchCommitCount(repoPath, branch)
      status.message =
        commits > 0
          ? `agent imported ${prepared.facts.length} candidate fact(s) onto ${branch} (${commits} commit(s))${result.output ? ` — ${result.output.slice(0, 500)}` : ''}`
          : `agent finished without committing spec changes${result.output ? ` — ${result.output.slice(0, 500)}` : ''}`
    } finally {
      await removeWorktree(repoPath, worktree)
    }
  }

  /** Fallback: single-shot reduce via the chat backend. No codebase
   *  verification — kept for servers with no daemon/harness available. */
  private async runLlmReduce(
    repoPath: string,
    branch: string,
    facts: SpecFact[],
    sessionCount: number,
    status: SpecImportStatus,
  ): Promise<void> {
    status.phase = 'reducing'
    const llm = this.deps.llm()
    const tree = new Map<string, SpecComponent>()
    for (const meta of listSpecs(repoPath)) {
      const full = getSpec(repoPath, meta.id)
      if (full) tree.set(full.id, full)
    }
    const reduceReply = await llm.complete(
      [
        { role: 'system', content: REDUCE_SYSTEM_PROMPT },
        { role: 'user', content: reduceUserPrompt([...tree.values()], facts) },
      ],
      [],
    )
    const ops = parseJsonReply<{ ops: SpecImportOp[] }>(reduceReply.text)?.ops ?? []
    const { components, applied, skipped } = applyImportOps(tree, ops, this.now())
    status.applied = applied
    status.skipped = skipped
    status.phase = 'committing'
    await commitSpecTree(
      repoPath,
      branch,
      'HEAD',
      components,
      `spec: import decisions from ${sessionCount} session(s) [podium spec import]`,
    )
    status.message = `imported ${facts.length} fact(s) as ${applied} op(s) onto branch ${branch} (no-agent mode)`
  }
}
