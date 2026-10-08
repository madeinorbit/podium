import { RequestAnswer } from '@podium/client-graph/request-answer'
import { lazy } from '@podium/mobx-helpers'
import { action, compareShallow, runInAction } from 'mobx'
import type { Trpc } from '@/app/trpc'

export type ConversationHit = Awaited<ReturnType<Trpc['conversations']['search']['query']>>[number]
interface ConversationSearchInput {
  query?: string
  projectPath?: string
  limit: number
}

/** On-request search answer. Conversation record admission belongs to POD-5868;
 * until that mechanism lands, preserve the existing immutable response rows. */
export class ConversationSearchView extends RequestAnswer<ConversationHit[]> {
  constructor(
    private readonly query: (input: ConversationSearchInput) => Promise<ConversationHit[]>,
  ) {
    super()
  }
  @action async search(input: ConversationSearchInput): Promise<void> {
    await this.load(() => this.query(input))
    runInAction(() => {
      if (this.error) this.answer = []
    })
  }
  @lazy({ equals: compareShallow }) get hits(): ConversationHit[] {
    return this.answer ?? []
  }
}
