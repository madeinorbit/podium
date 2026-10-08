import { action, compareShallow, runInAction } from 'mobx'
import { RequestAnswer } from '@podium/client-graph/request-answer'
import { lazy } from '@podium/mobx-helpers'
import type { MachineId } from '@podium/model'
import type { Trpc } from '@/app/trpc'
import { fileMentions } from './at-mention/mention-sources'

export class FileMentionView extends RequestAnswer<string[]> {
  constructor(private readonly trpc: Pick<Trpc, 'files'>) {
    super()
  }
  @action async search(input: {
    root: string
    query: string
    limit: number
    machineId?: MachineId
  }): Promise<void> {
    await this.load(async () => (await this.trpc.files.search.query(input)).paths)
    runInAction(() => {
      if (this.error) this.answer = []
    })
  }
  @lazy({ equals: compareShallow }) get options() {
    return fileMentions(this.answer ?? [])
  }
}
