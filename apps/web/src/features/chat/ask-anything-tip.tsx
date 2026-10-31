import type { SessionModel } from '@podium/client-graph/models'
import type { AgentPhase } from '@podium/model/browser'
import { observer } from 'mobx-react-lite'
import type { JSX } from 'react'
import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useTipMoment } from '@/features/tips'
import { TipContext } from '@/features/tips/tip-context'

/**
 * FIRST FLIGHTS, MOMENT 3: ASK-ANYTHING (POD-2198).
 *
 * The first time an agent the person is watching finishes a turn (its phase
 * goes working → idle), the composer under it is the place to say what next,
 * and the tip says an agent can do more than answer: start tasks, check on
 * other agents. The examples are drafts, never sends.
 */
export const ASK_ANYTHING_EXAMPLES = [
  'Start a task to fix the flaky login test',
  'Check with the checkout agents. Where does payment stand?',
] as const

/** Per session, so the card points at the composer of the session that finished
 *  even when several chats are mounted. */
export const askAnythingAnchor = (sessionId: string): string => `chat-composer:${sessionId}`

/** A turn that was running counts; compaction sits inside a turn. */
const RUNNING: ReadonlySet<AgentPhase | undefined> = new Set(['working', 'compacting'])

/** Where an example lands: after whatever is in the box at the moment of the
 *  click, never a copy of the draft taken when the card opened. */
export function appendExample(draft: string, example: string): string {
  return draft.trim() ? `${draft}\n${example}` : example
}

/**
 * Registered for the composer's lifetime, so the guide can replay it. Only the
 * small watcher below reads the agent's phase, and only until the moment is
 * seen: an account that has had the tip pays nothing on each turn.
 */
export const AskAnythingTip = observer(function AskAnythingTip({
  sessionId,
  session,
  viewing,
  taskChat,
  onExample,
}: {
  sessionId: string
  session: Pick<SessionModel, 'agentPhase'> | undefined
  /** The chat is the one on screen. A turn that ends out of sight fires nothing. */
  viewing: boolean
  /** A task's agent chat. The superagent's thread is not one: the moment
   *  belongs to a task the person has open. */
  taskChat: boolean
  /** Called at click time; it reads the draft then. */
  onExample: (text: string) => void
}): JSX.Element | null {
  const log = useContext(TipContext)?.log
  const [finished, setFinished] = useState(false)
  const onFinished = useCallback(() => setFinished(true), [])
  useTipMoment('ask-anything', {
    active: finished && viewing && taskChat,
    cards: [
      {
        anchor: askAnythingAnchor(sessionId),
        title: 'Agents run Podium too.',
        body: 'Ask any agent to start a new task, or to check in with other agents for you.',
        extra: <AskAnythingExamples onPick={onExample} />,
      },
    ],
  })
  const watching =
    !finished && viewing && taskChat && log?.enabled !== false && !log?.isSeen('ask-anything')
  return watching && session ? <TurnEndWatch session={session} onFinished={onFinished} /> : null
})

/** Mounted while the chat is on screen, so a turn that ended out of sight is
 *  already idle here and fires nothing. */
const TurnEndWatch = observer(function TurnEndWatch({
  session,
  onFinished,
}: {
  session: Pick<SessionModel, 'agentPhase'>
  onFinished: () => void
}): null {
  const phase = session.agentPhase
  const previous = useRef(phase)
  useEffect(() => {
    if (phase === 'idle' && RUNNING.has(previous.current)) onFinished()
    previous.current = phase
  }, [phase, onFinished])
  return null
})

function AskAnythingExamples({ onPick }: { onPick: (text: string) => void }): JSX.Element {
  return (
    <div className="flex flex-col items-start gap-1.5">
      {ASK_ANYTHING_EXAMPLES.map((text) => (
        <button
          key={text}
          type="button"
          title="Put in the message box"
          className="rounded-[7px] border border-border bg-background px-2 py-1 text-left text-[11px] leading-4 text-foreground hover:border-primary/60 hover:bg-accent"
          onClick={() => onPick(text)}
        >
          {text}
        </button>
      ))}
    </div>
  )
}
