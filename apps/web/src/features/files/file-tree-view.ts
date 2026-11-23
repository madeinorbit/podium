import { AnswerRefresh, type AnswerSignal } from '@podium/client-graph/answer-refresh'
import { RequestAnswer } from '@podium/client-graph/request-answer'
import { lazy } from '@podium/mobx-helpers'
import type { MachineId } from '@podium/model'
import { action, observable, observableRef, runInAction } from 'mobx'
import { formatAppError } from '@/app/AppErrorPage'
import type { Trpc } from '@/app/trpc'
import { compareEntries } from './entry-order'

export type DirectoryEntry = { name: string; isDir: boolean }
export interface FileTreePorts {
  refreshSignal?: AnswerSignal
  listDir(input: {
    root: string
    path?: string
    machineId?: MachineId
  }): Promise<{ ok: boolean; entries: DirectoryEntry[]; error?: string; path: string }>
  trpc: Pick<Trpc, 'files'>
}

/** Directory listings are one tree answer, not a cache of record models. */
export class FileTreeView {
  @observableRef accessor children: Record<string, DirectoryEntry[]> = {}
  readonly expanded = observable.set<string>()
  readonly loadingDirs = observable.set<string>()
  @observable accessor error: string | null = null
  readonly search = new RequestAnswer<string[]>()
  private generation = 0
  private query = ''
  private readonly refreshes: AnswerRefresh
  constructor(
    readonly root: string,
    private readonly machineId: MachineId | undefined,
    private readonly ports: FileTreePorts,
  ) {
    this.refreshes = new AnswerRefresh(() => this.refreshChanged(), ports.refreshSignal)
  }
  open(): void {
    this.refreshes.open()
  }
  private async refreshChanged(): Promise<void> {
    await Promise.all([this.load(this.root), ...[...this.expanded].map((dir) => this.load(dir))])
    if (this.query) await this.searchFiles(this.query)
  }

  @lazy get loading(): boolean {
    return this.loadingDirs.size > 0
  }
  @action async load(dir: string): Promise<void> {
    if (this.loadingDirs.has(dir)) return
    const generation = this.generation
    this.loadingDirs.add(dir)
    try {
      const result = await this.ports.listDir({
        root: this.root,
        machineId: this.machineId,
        path: dir,
      })
      runInAction(() => {
        if (generation !== this.generation) return
        if (!result.ok) {
          this.error = result.error ?? 'Could not open directory'
          return
        }
        this.error = null
        this.children = { ...this.children, [dir]: [...result.entries].sort(compareEntries) }
      })
    } catch (cause) {
      runInAction(() => {
        if (generation === this.generation)
          this.error = formatAppError(cause, 'Could not open directory')
      })
    } finally {
      runInAction(() => {
        if (generation === this.generation) this.loadingDirs.delete(dir)
      })
    }
  }
  @action toggleDir(dir: string): void {
    if (!this.expanded.delete(dir)) {
      this.expanded.add(dir)
      this.refreshes.refresh()
    }
  }
  @action refresh(): void {
    ++this.generation
    this.children = {}
    this.expanded.clear()
    this.loadingDirs.clear()
    this.error = null
    this.refreshes.refresh()
  }
  @action clearSearch(): void {
    this.query = ''
    this.search.close()
  }
  searchFiles(query: string): Promise<void> {
    this.query = query
    return this.search.load(
      async () =>
        (
          await this.ports.trpc.files.search.query({
            root: this.root,
            machineId: this.machineId,
            query,
            limit: 50,
          })
        ).paths,
      true,
    )
  }
  @action close(): void {
    this.refreshes.close()
    this.query = ''
    ++this.generation
    this.children = {}
    this.expanded.clear()
    this.loadingDirs.clear()
    this.error = null
    this.search.close()
  }
}
