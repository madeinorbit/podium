/**
 * THE CARD DRAWN FROM STATE, PHOTOGRAPHED (POD-1273).
 *
 * A unit test can prove that `pendingAskFromState` yields a block and that the
 * card renders its labels; it cannot show that the object looks like the
 * transcript's own card, because the signal frame, the option rows and the
 * attention keyline are entirely CSS that jsdom never applies. This mounts the
 * shipping `AskUserQuestionCard` against the real stylesheet, on both sides of
 * the fix, so the two can be compared at the same width:
 *
 *   before  what the feed had while the question was waiting — nothing. The
 *           transcript carries no item until Claude Code resolves the call.
 *   after   the same card, built from `agentState.need.interview`.
 *
 * `window.probe.mode('before'|'after')` switches; the card needs no store, so
 * this harness stubs nothing.
 */
import { pendingAskFromState } from '@podium/client-core/viewmodels'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from '@/app/theme'
import { AskUserQuestionCard } from '@/features/chat/AskUserQuestionCard'
import type { ChatBlock } from '@/features/chat/chat'
import '@/index.css'
import '@/styles.css'

declare global {
  interface Window {
    probe: { mode: (m: 'before' | 'after') => void }
  }
}

/** The real ask POD-1271-A has been stuck behind since 09:30. */
const NEED = {
  kind: 'question' as const,
  summary: 'Where should the clickable status icon land?',
  interview: {
    questions: [
      {
        question: 'Where should the clickable status icon land?',
        header: 'Placement',
        options: [
          {
            label: 'The issue row (Recommended)',
            description: 'Where the glyph already sits, in every list that draws one.',
          },
          {
            label: 'The issue page rail',
            description: 'Beside the labelled dropdown the page already has.',
          },
          {
            label: 'Both surfaces',
            description: 'One picker component, mounted twice.',
          },
        ],
      },
    ],
  },
}

function Harness(): JSX.Element {
  const [mode, setMode] = useState<'before' | 'after'>('after')

  useEffect(() => {
    window.probe = { mode: setMode }
  }, [])

  // Exactly what the feed asks for: the transcript has nothing pending, the
  // session is live, and the agent is waiting on a question.
  const block = pendingAskFromState(NEED, 'live', 'needs_user', false) as ChatBlock | null

  return (
    <ThemeProvider>
      <div className="bg-background p-6">
        <div className="mx-auto max-w-[760px]">
          <div className="mb-3 font-mono text-[11px] text-muted-foreground uppercase tracking-wide">
            {mode === 'before'
              ? 'before — session blocked on a question, transcript empty'
              : 'after — the same wait, drawn from agent state'}
          </div>
          {mode === 'before' ? (
            // The whole finding: the feed rendered nothing at all here, and the
            // composer below it was closed because the session is needs_user.
            <div className="rounded border border-dashed border-input p-8 text-center text-muted-foreground text-sm">
              (nothing)
            </div>
          ) : (
            block && (
              <AskUserQuestionCard
                block={block}
                cls="transcript-row"
                index={0}
                livePending={true}
                onAnswer={async () => {
                  /* the real card posts option numbers to the server */
                }}
              />
            )
          )}
        </div>
      </div>
    </ThemeProvider>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<Harness />)
