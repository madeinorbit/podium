import { actorSystem, type IssueId, type UserId } from '@podium/model'
import type { MessageSender, MessageSendInput } from '../messages/types'

/** The job a reassignment notice is sent as. */
export const REASSIGN_NOTICE_JOB = 'issue-reassign'

export interface ReassignmentFacts {
  issueId: IssueId
  seq: number
  title: string
  from: UserId
  to: UserId
  by: UserId
}

/**
 * THE TWO INBOX NOTICES OF A REASSIGNMENT (POD-6287, design §2.2/§4.3, MU-24).
 *
 * The old and the new assignee each get one, in their own inbox: a person's
 * inbox is the operator box narrowed to the rows meant for them
 * (`attribution.onBehalfOf`, `mayViewAs`), so each notice names its recipient
 * there and nobody else reads it. Both are told even when one of them made the
 * change, so the record of who answers for the task is in both their inboxes.
 */
export function reassignmentNotices(
  facts: ReassignmentFacts,
  nameOf: (user: UserId) => string,
): { recipient: UserId; sender: MessageSender; input: MessageSendInput }[] {
  const task = `#${facts.seq} “${facts.title}”`
  const by = (recipient: UserId) => (facts.by === recipient ? 'You' : nameOf(facts.by))
  const notice = (recipient: UserId, body: string) => ({
    recipient,
    sender: {
      kind: 'system' as const,
      name: REASSIGN_NOTICE_JOB,
      attribution: { actor: actorSystem(REASSIGN_NOTICE_JOB), onBehalfOf: recipient },
      delegationRef: null,
    },
    input: { to: { kind: 'operator' as const }, kind: 'notification' as const, body },
  })
  const toYou = facts.by === facts.to ? 'assigned yourself' : 'assigned you'
  return [
    notice(facts.to, `${by(facts.to)} ${toYou} ${task}. You are now its assignee.`),
    notice(
      facts.from,
      `${by(facts.from)} reassigned ${task} from you to ${facts.from === facts.to ? 'you' : nameOf(facts.to)}. ` +
        'Your sessions on it keep running as yours.',
    ),
  ]
}
