import { observer } from 'mobx-react-lite'
import type { ComponentProps } from 'react'
import { useSessionConversation } from '../SessionConversation'
import { TaskSummary } from './TaskOverview'

type Props = Omit<ComponentProps<typeof TaskSummary>, 'offer' | 'onAccept'>

/** The task page borrows chat's conversation and its send/offer state. */
export function TaskOfferSummary(props: Props) {
  return props.lead ? (
    <SessionSummary key={props.lead.sessionId} {...props} lead={props.lead} />
  ) : (
    <TaskSummary {...props} offer={null} onAccept={async () => {}} />
  )
}

const SessionSummary = observer(function SessionSummary(
  props: Props & { lead: NonNullable<Props['lead']> },
) {
  const conversation = useSessionConversation({ session: props.lead })
  return (
    <TaskSummary
      {...props}
      offer={conversation?.offer ?? null}
      onAccept={async (sessionId, prompt, createdAt) => {
        if (
          !conversation ||
          conversation.session?.sessionId !== sessionId ||
          conversation.offer?.createdAt !== createdAt
        ) {
          throw new Error('This offer has changed. Open the current offer to answer it.')
        }
        const turn = await conversation.sendOffer(prompt, createdAt)
        if (!turn) throw new Error('This conversation is not ready. Try again.')
        if (turn.state === 'failed') throw new Error(turn.error ?? 'The answer could not be sent.')
      }}
    />
  )
})
