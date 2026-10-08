import { RequestAnswer } from '@podium/client-graph/request-answer'
import { action, observable, runInAction } from 'mobx'
import { lazy } from '@podium/mobx-helpers'
import type { MachineId } from '@podium/model'
import type { FileTreePorts } from './file-tree-view'
import { compareEntries } from './entry-order'
import { formatAppError } from '@/app/AppErrorPage'

type DirectoryAnswer = Awaited<ReturnType<FileTreePorts['listDir']>>
export class FileBrowserView extends RequestAnswer<DirectoryAnswer> {
  @observable accessor path: string
  @observable accessor resolvedRoot: string | null = null
  private generation = 0
  constructor(readonly root: string, readonly machineId: MachineId | undefined, private readonly listDir: FileTreePorts['listDir']) {
    super(cause => formatAppError(cause, 'Could not open directory'))
    this.path = root
  }
  @lazy get entries() { return this.answer?.entries ?? [] }
  @action async open(next = this.root): Promise<void> {
    const generation = ++this.generation
    await this.load(async () => {
      const result = await this.listDir({ root: this.root, machineId: this.machineId, path: next })
      if (!result.ok) throw new Error(result.error ?? 'Could not open directory')
      return { ...result, entries: [...result.entries].sort(compareEntries) }
    }, true)
    runInAction(() => {
      if (generation !== this.generation || !this.answer) return
      this.resolvedRoot ??= this.answer.path
      this.path = this.answer.path
    })
  }
  @action override close(): void { ++this.generation; super.close(); this.path = this.root; this.resolvedRoot = null }
}
