import { RequestAnswer, answerError } from '@podium/client-graph/request-answer'
import { action, observable, observableRef, runInAction } from 'mobx'
import type { MachineId } from '@podium/model'
import type { Trpc } from '@/app/trpc'
import { compareEntries } from './entry-order'

export type DirectoryEntry = { name: string; isDir: boolean }
export interface FileTreePorts {
  listDir(input: { root: string; path?: string; machineId?: MachineId }): Promise<{ ok: boolean; entries: DirectoryEntry[]; error?: string; path: string }>
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
  constructor(readonly root: string, private readonly machineId: MachineId | undefined, private readonly ports: FileTreePorts) {}

  @action async load(dir: string): Promise<void> {
    if (this.loadingDirs.has(dir)) return
    const generation = this.generation
    this.loadingDirs.add(dir)
    try {
      const result = await this.ports.listDir({ root: this.root, machineId: this.machineId, path: dir })
      runInAction(() => {
        if (generation !== this.generation) return
        if (!result.ok) { this.error = result.error ?? 'Could not open directory'; return }
        this.error = null
        this.children = { ...this.children, [dir]: [...result.entries].sort(compareEntries) }
      })
    } catch (cause) {
      runInAction(() => { if (generation === this.generation) this.error = answerError(cause) })
    } finally {
      runInAction(() => { if (generation === this.generation) this.loadingDirs.delete(dir) })
    }
  }
  @action toggleDir(dir: string): void {
    if (!this.expanded.delete(dir)) {
      this.expanded.add(dir)
      if (this.children[dir] === undefined) void this.load(dir)
    }
  }
  @action refresh(): void {
    ++this.generation
    this.children = {}
    this.expanded.clear()
    this.loadingDirs.clear()
    this.error = null
    void this.load(this.root)
  }
  searchFiles(query: string): Promise<void> {
    return this.search.load(async () => (await this.ports.trpc.files.search.query({ root: this.root, machineId: this.machineId, query, limit: 50 })).paths, true)
  }
  @action close(): void {
    ++this.generation
    this.children = {}
    this.expanded.clear()
    this.loadingDirs.clear()
    this.error = null
    this.search.close()
  }
}
