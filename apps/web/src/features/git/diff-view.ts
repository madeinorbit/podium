import { RequestAnswer } from '@podium/client-graph/request-answer'
import { action, observable, observableRef, runInAction } from 'mobx'
import type { MachineId } from '@podium/model'
import type { Trpc } from '@/app/trpc'
import { parseDiff, type ParsedDiff } from './diff-model'
import { untrackedDiff, type StatusEntry } from './git-panel'

export interface DiffState { loading: boolean; parsed?: ParsedDiff; error?: string | null; note?: string }
interface DiffPorts {
  gitDiffFile: (input: { machineId?: MachineId; root: string; path: string }) => Promise<{ ok: boolean; output: string }>
  gitCommitDiffFile: (input: { machineId?: MachineId; root: string; sha: string; path: string }) => Promise<{ ok: boolean; output: string }>
  readFileScoped: (scope: { kind: 'worktree'; machineId?: MachineId; root: string }, path: string) => Promise<Awaited<ReturnType<Trpc['files']['read']['query']>>>
}

/** Selected-file answers and incremental totals belong to one open diff sheet. */
export class DiffView {
  readonly states = observable.map<string, DiffState>(undefined, { deep: false })
  @observableRef accessor totals = { settled: 0, added: 0, removed: 0 }
  private generation = 0
  constructor(private readonly cwd: string, private readonly machineId: MachineId | undefined, private readonly ports: DiffPorts, private readonly sources?: Record<string, string>, private readonly commitSha?: string) {}
  @action async load(entry: StatusEntry): Promise<void> {
    if (this.states.has(entry.path)) return
    const generation = this.generation
    const pending = { loading: true }
    this.states.set(entry.path, pending)
    const request = new RequestAnswer<Omit<DiffState, 'loading' | 'error'>>()
    await request.load(async () => {
      const given = this.sources?.[entry.path]
      if (this.commitSha) {
        const result = await this.ports.gitCommitDiffFile({ machineId: this.machineId, root: this.cwd, sha: this.commitSha, path: entry.path })
        if (!result.ok) throw new Error(result.output || 'git could not diff this file.')
        return { parsed: parseDiff(result.output) }
      }
      if (given !== undefined) return { parsed: parseDiff(given) }
      if (entry.untracked && entry.path.endsWith('/')) return { note: 'A new folder. Git lists it as one entry until something inside it is tracked, so there is no diff to show yet.' }
      if (entry.untracked) {
        const result = await this.ports.readFileScoped({ kind: 'worktree', machineId: this.machineId, root: this.cwd }, entry.path)
        if (result.ok && result.content !== undefined) return { parsed: parseDiff(untrackedDiff(result.content)) }
        if (result.binary) return { note: 'A binary file — there are no text lines to diff.' }
        if (result.tooLarge) return { note: 'This file is too large to read here.' }
        throw new Error(result.error ?? 'This file could not be read.')
      }
      const result = await this.ports.gitDiffFile({ machineId: this.machineId, root: this.cwd, path: entry.path })
      if (!result.ok) throw new Error(result.output || 'git could not diff this file.')
      return { parsed: parseDiff(result.output) }
    })
    runInAction(() => {
      if (generation !== this.generation || this.states.get(entry.path) !== pending) return
      const next = { loading: false, error: request.error, ...request.answer }
      this.states.set(entry.path, next)
      this.totals = { settled: this.totals.settled + 1, added: this.totals.added + (next.parsed?.added ?? 0), removed: this.totals.removed + (next.parsed?.removed ?? 0) }
    })
  }
  @action close(): void { ++this.generation; this.states.clear(); this.totals = { settled: 0, added: 0, removed: 0 } }
}
