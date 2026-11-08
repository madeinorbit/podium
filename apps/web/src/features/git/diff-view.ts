import { AnswerRefresh, type AnswerSignal } from '@podium/client-graph/answer-refresh'
import { RequestAnswer } from '@podium/client-graph/request-answer'
import type { MachineId } from '@podium/model'
import { action, observable, observableRef, runInAction } from 'mobx'
import type { Trpc } from '@/app/trpc'
import { type ParsedDiff, parseDiff } from './diff-model'
import { type StatusEntry, untrackedDiff } from './git-panel'

export interface DiffState {
  loading: boolean
  parsed?: ParsedDiff
  error?: string | null
  note?: string
}
interface DiffPorts {
  refreshSignal?: AnswerSignal
  gitDiffFile: (input: {
    machineId?: MachineId
    root: string
    path: string
  }) => Promise<{ ok: boolean; output: string }>
  gitCommitDiffFile: (input: {
    machineId?: MachineId
    root: string
    sha: string
    path: string
  }) => Promise<{ ok: boolean; output: string }>
  readFileScoped: (
    scope: { kind: 'worktree'; machineId?: MachineId; root: string },
    path: string,
  ) => Promise<
    Pick<
      Awaited<ReturnType<Trpc['files']['read']['query']>>,
      'ok' | 'content' | 'tooLarge' | 'binary' | 'error'
    >
  >
}

/** Selected-file answers and incremental totals belong to one open diff sheet. */
export class DiffView {
  readonly states = observable.map<string, DiffState>(undefined, { deep: false })
  @observableRef accessor totals = { settled: 0, added: 0, removed: 0 }
  private generation = 0
  private readonly entries = new Map<string, StatusEntry>()
  private readonly refreshes: AnswerRefresh
  constructor(
    private readonly cwd: string,
    private readonly machineId: MachineId | undefined,
    private readonly ports: DiffPorts,
    private readonly sources?: Record<string, string>,
    private readonly commitSha?: string,
  ) {
    // Commit diffs are immutable, explicitly stored for this opening.
    this.refreshes = new AnswerRefresh(async () => {
      await Promise.all([...this.entries.values()].map((entry) => this.load(entry, true)))
    }, ports.refreshSignal)
  }
  open(): void {
    if (!this.commitSha) this.refreshes.open()
  }
  @action async load(entry: StatusEntry, changed = false): Promise<void> {
    this.entries.set(entry.path, entry)
    if (!changed && this.states.has(entry.path)) return
    const generation = this.generation
    const pending = { loading: true }
    this.states.set(entry.path, pending)
    const request = new RequestAnswer<Omit<DiffState, 'loading' | 'error'>>()
    await request.load(async () => {
      const given = changed ? undefined : this.sources?.[entry.path]
      if (this.commitSha) {
        const result = await this.ports.gitCommitDiffFile({
          machineId: this.machineId,
          root: this.cwd,
          sha: this.commitSha,
          path: entry.path,
        })
        if (!result.ok) throw new Error(result.output || 'git could not diff this file.')
        return { parsed: parseDiff(result.output) }
      }
      if (given !== undefined) return { parsed: parseDiff(given) }
      if (entry.untracked && entry.path.endsWith('/'))
        return {
          note: 'A new folder. Git lists it as one entry until something inside it is tracked, so there is no diff to show yet.',
        }
      if (entry.untracked) {
        const result = await this.ports.readFileScoped(
          { kind: 'worktree', machineId: this.machineId, root: this.cwd },
          entry.path,
        )
        if (result.ok && result.content !== undefined)
          return { parsed: parseDiff(untrackedDiff(result.content)) }
        if (result.binary) return { note: 'A binary file — there are no text lines to diff.' }
        if (result.tooLarge) return { note: 'This file is too large to read here.' }
        throw new Error(result.error ?? 'This file could not be read.')
      }
      const result = await this.ports.gitDiffFile({
        machineId: this.machineId,
        root: this.cwd,
        path: entry.path,
      })
      if (!result.ok) throw new Error(result.output || 'git could not diff this file.')
      return { parsed: parseDiff(result.output) }
    })
    runInAction(() => {
      if (generation !== this.generation || this.states.get(entry.path) !== pending) return
      const next = { loading: false, error: request.error, ...request.answer }
      this.states.set(entry.path, next)
      this.totals = [...this.states.values()].reduce(
        (total, state) => ({
          settled: total.settled + (state.loading ? 0 : 1),
          added: total.added + (state.parsed?.added ?? 0),
          removed: total.removed + (state.parsed?.removed ?? 0),
        }),
        { settled: 0, added: 0, removed: 0 },
      )
    })
  }
  @action close(): void {
    this.refreshes.close()
    this.entries.clear()
    ++this.generation
    this.states.clear()
    this.totals = { settled: 0, added: 0, removed: 0 }
  }
}
