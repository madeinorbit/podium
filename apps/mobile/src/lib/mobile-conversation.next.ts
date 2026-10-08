import { Conversation, type ConversationOptions } from '@podium/client-core/conversation'
import { MobileConversationPresentation } from './conversation-presentation'
import { shapeMobileChatRow } from './transcript-feed'

/** The conversation owns phone row membership in the same source action. */
export class MobileConversation extends Conversation {
  private readonly readers = new Set<() => boolean>()
  readonly presentation: MobileConversationPresentation

  constructor(options: ConversationOptions, presentationOptions: {
    collapseContext?: boolean
    hidePendingQuestion?: boolean
  } = {}) {
    let presentation: MobileConversationPresentation | undefined
    super({ ...options, transcript: { ...options.transcript, retainHistory: () => [...this.readers].some(read => read()) }, onTranscriptChange: change => {
      presentation?.apply(this.graph.rowPublication)
      options.onTranscriptChange?.(change)
    } })
    this.presentation = presentation = new MobileConversationPresentation(
      this.graph, shapeMobileChatRow, id => this.graph.itemPosition(id), {
        collapseContext: presentationOptions.collapseContext,
        hiddenQuestionId: presentationOptions.hidePendingQuestion
          ? () => this.transcript.pendingQuestion?.id : undefined,
      },
    )
  }

  addReader(retainHistory: () => boolean): () => void {
    this.readers.add(retainHistory)
    return () => { this.readers.delete(retainHistory) }
  }

  override dispose(): void {
    this.readers.clear()
    this.presentation.dispose()
    super.dispose()
  }
}
