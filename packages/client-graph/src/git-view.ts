import { action, observable, observableRef, runInAction } from 'mobx'
import { lazy } from '@podium/mobx-helpers'
import type { MachineId } from '@podium/model'
import { RequestAnswer } from './request-answer'
import { parseStatus, parseLog, parseCommitFiles, type StatusEntry } from './git-panel'
import {
  parseDiff,
  parseStatus as parseReviewStatus,
  untrackedDiff,
  type ParsedDiff,
} from './git-review'

interface GitResult {
  ok: boolean
  output: string
}
interface FileReadResult {
  ok: boolean
  content?: string
  error?: string
  binary?: boolean
  tooLarge?: boolean
}
interface GitArgs {
  root: string
  machineId?: MachineId
}
export interface GitViewPorts {
  gitStatus(input: GitArgs): Promise<GitResult>
  gitLog?(input: GitArgs): Promise<GitResult>
  gitCommitFiles?(input: GitArgs & { sha: string }): Promise<GitResult>
  gitDiffFile(input: GitArgs & { path: string }): Promise<GitResult>
  readFileScoped(scope: GitArgs & { kind: 'worktree' }, path: string): Promise<unknown>
}
export type ReviewDiff = { parsed?: ParsedDiff; note?: string }
export interface CommitAnswer {
  loading: boolean
  error: string | null
  entries?: StatusEntry[]
}
export interface ReviewDiffAnswer {
  loading: boolean
  error: string | null
  answer?: ReviewDiff
}

/** The Git view's request owner, shared by desktop and phone. Platform parsers
 * keep their existing presentation; both read the same raw status answer. */
export class GitView {
  readonly inventory = new RequestAnswer<{ status: GitResult; log?: GitResult }>()
  @observableRef accessor commitFiles: Record<string, CommitAnswer> = {}
  @observableRef accessor diffs: Record<string, ReviewDiffAnswer> = {}
  readonly openShas = observable.set<string>()
  @observable accessor openPath: string | null = null
  @observable accessor now = Date.now()
  private generation = 0
  constructor(
    readonly root: string,
    readonly machineId: MachineId | undefined,
    private readonly ports: GitViewPorts,
  ) {}
  private get args(): GitArgs {
    return {
      root: this.root,
      ...(this.machineId === undefined ? {} : { machineId: this.machineId }),
    }
  }
  @lazy get status() {
    const result = this.inventory.answer?.status
    return result?.ok ? parseStatus(result.output) : null
  }
  @lazy get reviewStatus() {
    const result = this.inventory.answer?.status
    return result?.ok ? parseReviewStatus(result.output) : null
  }
  @lazy get log() {
    const result = this.inventory.answer?.log
    return result ? (result.ok ? parseLog(result.output) : []) : null
  }
  @lazy get error(): string | null {
    const result = this.inventory.answer?.status
    return (
      this.inventory.error ?? (result && !result.ok ? result.output || 'git status failed' : null)
    )
  }

  @action async refresh(history = false): Promise<void> {
    const generation = ++this.generation
    this.openPath = null
    this.diffs = {}
    await this.inventory.load(async () => {
      const [status, log] = await Promise.all([
        this.ports.gitStatus(this.args),
        history ? this.ports.gitLog?.(this.args) : undefined,
      ])
      // Phone refresh keeps its previous branch and inventory on a failed read.
      if (!history && !status.ok) throw new Error(status.output || 'Git status could not be read.')
      return { status, log }
    })
    runInAction(() => {
      if (generation === this.generation) this.now = Date.now()
    })
  }
  @action toggleCommit(sha: string): void {
    if (!this.openShas.delete(sha)) {
      this.openShas.add(sha)
      void this.loadCommit(sha)
    }
  }
  @action async loadCommit(sha: string): Promise<void> {
    if (this.commitFiles[sha] || !this.ports.gitCommitFiles) return
    // Immutable commit reads survive refresh, but never survive closing.
    const request = new RequestAnswer<StatusEntry[]>()
    const pending: CommitAnswer = { loading: true, error: null }
    this.commitFiles = { ...this.commitFiles, [sha]: pending }
    await request.load(async () => {
      const result = await this.ports.gitCommitFiles!({ ...this.args, sha })
      if (!result.ok) throw new Error(result.output || 'git could not read this commit.')
      return parseCommitFiles(result.output)
    })
    runInAction(() => {
      if (this.commitFiles[sha] === pending)
        this.commitFiles = {
          ...this.commitFiles,
          [sha]: { loading: false, error: request.error, entries: request.answer },
        }
    })
  }
  @action toggleFile(entry: StatusEntry): void {
    if (this.openPath === entry.path) {
      this.openPath = null
      return
    }
    this.openPath = entry.path
    if (!this.diffs[entry.path]) void this.loadDiff(entry)
  }
  @action async loadDiff(entry: StatusEntry): Promise<void> {
    const generation = this.generation
    this.diffs = { ...this.diffs, [entry.path]: { loading: true, error: null } }
    const request = new RequestAnswer<ReviewDiff>()
    await request.load(async () => {
      if (entry.untracked && entry.path.endsWith('/'))
        return { note: 'Open this folder on desktop to review its contents.' }
      const read = (path: string) =>
        this.ports.readFileScoped({ kind: 'worktree', ...this.args }, path)
      const fromRead = (wire: unknown, source = ''): ReviewDiff => {
        const result = wire as FileReadResult
        if (result.ok && result.content !== undefined)
          return {
            parsed: parseDiff([source, untrackedDiff(result.content)].filter(Boolean).join('\n')),
          }
        if (result.binary) return { note: 'Binary file. No text diff is available.' }
        if (result.tooLarge) return { note: 'This file is too large for an inline review.' }
        throw new Error(result.error || 'This file could not be read.')
      }
      if (entry.untracked) return fromRead(await read(entry.path))
      const result = await this.ports.gitDiffFile({
        ...this.args,
        path:
          entry.renamedFrom && (entry.y === 'R' || entry.y === 'C')
            ? entry.renamedFrom
            : entry.path,
      })
      if (!result.ok) throw new Error(result.output || 'Git could not diff this file.')
      if (entry.renamedFrom && (entry.y === 'R' || entry.y === 'C'))
        return fromRead(await read(entry.path), result.output)
      return { parsed: parseDiff(result.output) }
    })
    runInAction(() => {
      if (generation === this.generation)
        this.diffs = {
          ...this.diffs,
          [entry.path]: { loading: false, error: request.error, answer: request.answer },
        }
    })
  }
  @action close(): void {
    ++this.generation
    this.inventory.close()
    this.commitFiles = {}
    this.diffs = {}
    this.openShas.clear()
    this.openPath = null
  }
}
