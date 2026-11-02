import type { DeckIssueState, IssueContinuation } from '@podium/client-core/values'
import { MissionScreen } from '@podium/client-graph/mission-screen'
import type { MobxPool } from '@podium/client-graph/pool'
import { observer } from '@podium/client-graph/react'
import { issueDisplayRef } from '@podium/protocol'
import { ArrowRight, Check } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { STAGE_LABELS } from '@/features/issues/issue-card'
import { StageGlyph } from '@/features/issues/issue-glyphs'
import { cn } from '@/lib/utils'
import { SpinOffProposals } from './FlightDeckProposals'
import { useMissionEndings } from './mission-endings'
import { useWorklistPool } from './store-worklist-pool'

/**
 * THE PANE OF A TASK WHOSE CONVERSATION MOVED (POD-2043).
 *
 * `attach --spinoff` takes the session with it: the follow-up the operator asked
 * becomes its own task and the chat goes there. The task left behind has no
 * session, so the pane used to say "Nothing open in this pane" and point at a
 * flight deck that a small screen does not show. This says what happened, what
 * this task found (its state note is the only copy left here, because the
 * answer is in the transcript that moved), where the chat is now, what it filed,
 * and the one decision this task is waiting for.
 *
 * Anything else, or a mission still loading, draws `fallback`.
 */
export function MovedConversationPane({
  issueId,
  fallback,
}: {
  issueId: string
  fallback: ReactNode
}): JSX.Element {
  const pool = useWorklistPool()
  return pool ? (
    <MovedOpening key={issueId} pool={pool} issueId={issueId} fallback={fallback} />
  ) : (
    <>{fallback}</>
  )
}

/** One opening: creates the task's view model, closes it on unmount. */
const MovedOpening = observer(function MovedOpening({
  pool,
  issueId,
  fallback,
}: {
  pool: MobxPool
  issueId: string
  fallback: ReactNode
}): JSX.Element {
  const screen = useMemo(() => new MissionScreen(pool, issueId), [pool, issueId])
  useEffect(() => () => screen.close(), [screen])
  const continuation = screen.ready && screen.conversationMoved ? screen.continuation : null
  return continuation ? (
    <MovedConversation screen={screen} continuation={continuation} />
  ) : (
    <>{fallback}</>
  )
})

const MovedConversation = observer(function MovedConversation({
  screen,
  continuation,
}: {
  screen: MissionScreen
  continuation: IssueContinuation
}): JSX.Element {
  const { openDeparture, tuckResolvedRoot, dialog } = useMissionEndings(screen)
  const target = continuation.target
  const findings = screen.rootFindings
  return (
    <div
      className="@container flex min-h-0 flex-1 overflow-y-auto"
      data-testid="moved-conversation"
    >
      <div className="m-auto flex w-full max-w-[540px] flex-col px-8 py-10 @max-[480px]:m-0 @max-[480px]:min-h-full @max-[480px]:px-[18px] @max-[480px]:py-7">
        <p className="shell-type-micro flex items-center gap-2 font-mono text-text-dim">
          <span aria-hidden className="size-[6px] rounded-full bg-attention" />
          {screen.rootRef} · {STAGE_LABELS[screen.rootStage]}
        </p>
        <h2 className="mt-2.5 text-[22px] leading-[1.25] font-semibold tracking-[-.02em] text-balance text-text-strong">
          Your conversation moved to {continuation.short}
        </h2>
        <p className="mt-2 text-[13.5px] leading-[1.6] text-pretty text-muted-foreground">
          Your follow-up became its own task and the agent took the chat with it.
        </p>
        {findings && <Findings text={findings} />}
        {target && (
          <PaneSection label="Your conversation">
            <button
              data-pressable
              type="button"
              data-testid="moved-conversation-target"
              className="flex w-full items-center gap-3 rounded-[10px] border border-border bg-muted/40 px-3.5 py-2.5 text-left hover:bg-muted"
              onClick={() => openDeparture(target)}
            >
              <StageGlyph stage={target.stage} />
              <span className="shell-type-micro flex-none font-mono font-semibold text-text-dim">
                {issueDisplayRef(target)}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13.5px] font-semibold text-text-strong">
                  {target.title}
                </span>
                <span className="text-[12px] text-text-dim @max-[480px]:hidden">
                  The agent and the chat are here now
                </span>
              </span>
              {screen.continuationState && <TargetState state={screen.continuationState} />}
            </button>
          </PaneSection>
        )}
        <div className="mt-6">
          <SpinOffProposals full={screen.full} onMenu={() => {}} />
        </div>
        <div className="mt-6 flex flex-wrap gap-2 @max-[480px]:mt-auto @max-[480px]:flex-col @max-[480px]:pt-6">
          <Button type="button" onClick={tuckResolvedRoot} data-testid="moved-conversation-tuck">
            <Check size={14} aria-hidden="true" />
            {screen.rootFinished ? 'Tuck away' : 'Done & tuck'}
          </Button>
          {target && (
            <Button type="button" variant="outline" onClick={() => openDeparture(target)}>
              Open {issueDisplayRef(target)}
              <ArrowRight size={14} aria-hidden="true" />
            </Button>
          )}
        </div>
        <p className="mt-3 text-[12px] text-text-faint @max-[480px]:text-center">
          Closing keeps what this task found.
        </p>
      </div>
      {dialog}
    </div>
  )
})

function PaneSection({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <section className="mt-6">
      <h3 className="shell-type-micro mb-2 font-mono tracking-[0.1em] text-text-faint uppercase">
        {label}
      </h3>
      {children}
    </section>
  )
}

/** The state note, clamped: the answer is usually its first sentences. */
function Findings({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <PaneSection label="What this task found">
      <div className="rounded-[12px] border border-border bg-muted/40 px-4 py-3.5">
        <p
          className={cn(
            'text-[13.5px] leading-[1.65] whitespace-pre-line text-foreground',
            !open && 'line-clamp-3',
          )}
        >
          {text}
        </p>
        <button
          type="button"
          className="mt-1.5 text-[12.5px] text-text-dim underline decoration-border underline-offset-3 hover:text-text-strong"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Less' : 'More'}
        </button>
      </div>
    </PaneSection>
  )
}

/** Where the chat stands now, in the deck's own words. */
function TargetState({ state }: { state: DeckIssueState }): JSX.Element {
  return (
    <span
      className={cn(
        'shell-type-micro flex flex-none items-center gap-1.5 font-mono whitespace-nowrap',
        state.attention ? 'text-attention' : 'text-text-dim',
      )}
    >
      {state.attention && <span aria-hidden className="size-[5px] rounded-full bg-attention" />}
      {state.label.toLowerCase()}
    </span>
  )
}
