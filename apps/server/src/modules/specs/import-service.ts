import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TRPCError } from '@trpc/server'
import type { ConversationSummaryWire, TranscriptItem } from '@podium/protocol'
import { z } from 'zod'
import type { LlmClient } from '../../llm'
import { getSpec, listSpecs, type SpecComponent } from '../../pspec'
import { batchDigests, distillTranscript } from '../../pspec-import-distill'
import {
  applyImportOps,
  commitSpecTree,
  MAP_SYSTEM_PROMPT,
  mapUserPrompt,
  parseJsonReply,
  REDUCE_SYSTEM_PROMPT,
  reduceUserPrompt,
  type SpecFact,
  type SpecImportOp,
} from '../../pspec-import'
import { branchExists } from '../../pspec-git'
import { isAllowedRoot } from '../../root-allowlist'

/**
 * `podium spec import` (#172) — bootstrap/refresh the spec from past sessions.
 *
 * Rerunnable: a per-repo state file records each processed conversation (keyed
 * by its stable podium id when present) with the transcript size it was
 * processed at, so reruns pick up only new sessions and grown transcripts.
 * The result is committed to a `spec-import/<date>` branch via git plumbing —
 * canon (the repo root checkout) is never written; review happens in the
 * specs branch-diff view.
 */

export const specImportInputs = {
  start: z.object({ repoPath: z.string().min(1) }),
  status: z.object({ repoPath: z.string().min(1) }),
} as const

export interface SpecImportStatus {
  phase: 'idle' | 'distilling' | 'mapping' | 'reducing' | 'committing' | 'done' | 'error'
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

export interface SpecImportDeps {
  repoRoots: () => string[]
  /** All conversations the server knows for this repo (any agent, any machine). */
  conversationsFor: (repoPath: string) => ConversationSummaryWire[]
  /** Full transcript read for one conversation; null when unavailable. */
  readItems: (conv: ConversationSummaryWire) => Promise<TranscriptItem[] | null>
  /** Chat client from the configured backend; throws LlmConfigError when unset. */
  llm: () => LlmClient
  /** $PODIUM_STATE_DIR/spec-import */
  stateDir: () => string
  now?: () => number
}

function convKey(c: ConversationSummaryWire): string {
  return c.podiumId ?? `${c.agentKind}:${c.id}`
}

export class SpecImportService {
  private readonly running = new Map<string, SpecImportStatus>()

  constructor(private readonly deps: SpecImportDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private stateFile(repoPath: string): string {
    // Repo path → filename: stable and filesystem-safe.
    const slug = repoPath.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')
    return join(this.deps.stateDir(), `${slug}.json`)
  }

  private loadState(repoPath: string): ImportStateFile {
    try {
      return JSON.parse(readFileSync(this.stateFile(repoPath), 'utf8')) as ImportStateFile
    } catch {
      return { processed: {} }
    }
  }

  private saveState(repoPath: string, state: ImportStateFile): void {
    mkdirSync(this.deps.stateDir(), { recursive: true })
    writeFileSync(this.stateFile(repoPath), JSON.stringify(state, null, 1), 'utf8')
  }

  status(input: { repoPath: string }): SpecImportStatus {
    return this.running.get(input.repoPath) ?? { phase: 'idle' }
  }

  /** Kick off an import run; returns immediately. Poll `status`. */
  start(input: { repoPath: string }): SpecImportStatus {
    const { repoPath } = input
    if (!isAllowedRoot(this.deps.repoRoots(), repoPath)) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'root is not a known repository path' })
    }
    const current = this.running.get(repoPath)
    if (current && !['idle', 'done', 'error'].includes(current.phase)) {
      throw new TRPCError({ code: 'CONFLICT', message: 'an import is already running for this repo' })
    }
    const llm = this.deps.llm() // fail fast on missing backend/key, before going async
    const status: SpecImportStatus = { phase: 'distilling', startedAt: this.now() }
    this.running.set(repoPath, status)
    void this.run(repoPath, llm, status).catch((err: unknown) => {
      status.phase = 'error'
      status.error = err instanceof Error ? err.message : String(err)
      status.finishedAt = this.now()
    })
    return status
  }

  private async run(repoPath: string, llm: LlmClient, status: SpecImportStatus): Promise<void> {
    const state = this.loadState(repoPath)
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
      if (!items || items.length === 0) continue
      const digest = distillTranscript(items, {
        conversationId: convKey(conv),
        agentKind: conv.agentKind,
        date: conv.updatedAt ?? conv.createdAt,
        branch: conv.git?.branch,
        title: conv.title,
      })
      if (digest) digests.push(digest)
      state.processed[convKey(conv)] = conv.sizeBytes ?? 0
    }

    if (digests.length === 0) {
      this.saveState(repoPath, state)
      status.phase = 'done'
      status.message = 'no new sessions with importable decisions'
      status.finishedAt = this.now()
      return
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
    if (facts.length === 0) {
      this.saveState(repoPath, state)
      status.phase = 'done'
      status.message = 'sessions contained no explicit human decisions'
      status.finishedAt = this.now()
      return
    }

    status.phase = 'reducing'
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
    const date = new Date(this.now()).toISOString().slice(0, 10)
    // update-ref would silently force-move an existing branch — probe first.
    let branch = `spec-import/${date}`
    for (let n = 2; await branchExists(repoPath, branch); n++) {
      branch = `spec-import/${date}-${n}`
    }
    await commitSpecTree(
      repoPath,
      branch,
      'HEAD',
      components,
      `spec: import decisions from ${digests.length} session(s) [podium spec import]`,
    )
    this.saveState(repoPath, state)
    status.branch = branch
    status.phase = 'done'
    status.message = `imported ${facts.length} fact(s) as ${applied} op(s) onto branch ${branch}`
    status.finishedAt = this.now()
  }
}
