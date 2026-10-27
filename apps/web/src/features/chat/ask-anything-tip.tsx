import type { AgentPhase } from '@podium/model/browser'
import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTipMoment } from '@/features/tips'

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

export function useAskAnythingTip({
  sessionId,
  phase,
  viewing,
  taskChat,
  onExample,
}: {
  sessionId: string
  phase: AgentPhase | undefined
  /** The chat is the one on screen. A turn that ends out of sight fires nothing. */
  viewing: boolean
  /** A task's agent chat. The superagent's thread is not one: the moment
   *  belongs to a task the person has open. */
  taskChat: boolean
  onExample: (text: string) => void
}): void {
  const [finished, setFinished] = useState(false)
  const previous = useRef(phase)
  useEffect(() => {
    if (viewing && phase === 'idle' && RUNNING.has(previous.current)) setFinished(true)
    previous.current = phase
  }, [phase, viewing])
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
}

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
