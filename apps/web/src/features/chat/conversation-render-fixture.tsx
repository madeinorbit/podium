import type { ComponentProps } from 'react'
import { ConversationPresentation } from './conversation-presentation'
import { TranscriptFeed as Feed } from './TranscriptFeed'
import { WebConversation as Conversation } from './use-conversation'
import type { ChatViewModel } from './chat-view-model'

/** Keep the existing render corpus's fixture API while its reader lives outside
 * the warm conversation. Production callers create a ChatViewModel per mount. */
export class WebConversation extends Conversation {
  readonly fixtureView: ChatViewModel
  constructor(...args: [...ConstructorParameters<typeof Conversation>, ConversationPresentation]) {
    const [options, pool, runtime, mount, presentation] = args
    super(options, pool, runtime, mount)
    this.addView(presentation)
    const conversation = this
    this.fixtureView = {
      presentation, headless: false, ctxSeq: null, session: undefined, activity: null,
      get pending() { return conversation.sends.bubbles },
    } as unknown as ChatViewModel
  }
}

export function TranscriptFeed(props: ComponentProps<typeof Feed>) {
  const chat = props.chat
  return <Feed {...props} chat={chat ? { ...chat, view: (chat.conversation as WebConversation).fixtureView } : undefined} />
}
