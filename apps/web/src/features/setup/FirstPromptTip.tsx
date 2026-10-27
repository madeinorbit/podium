import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import type { TipCard } from '@/features/tips'
import { useReducedMotion } from '@/lib/use-reduced-motion'
import './first-prompt-tip.css'

export const FIRST_PROMPT_ANCHOR = 'first-prompt-composer'

/** The example prompt, split into what it asks for, who does it, and when to ask. */
export const FIRST_PROMPT_DEMO = [
  { part: 'what', text: 'Add a dark mode.' },
  {
    part: 'who',
    text: 'Research with Sonnet 5.5 high, design with Opus 5.5 xhigh, build with GPT-6.1 Sol max.',
  },
  { part: 'when', text: 'Check in with me after the design.' },
] as const
const DEMO_TEXT = FIRST_PROMPT_DEMO.map(({ text }) => text).join(' ')
const TYPE_MS = 28

/**
 * THE DEMO IS PAINTED OVER THE BOX, NEVER TYPED INTO IT (POD-2196).
 *
 * The textarea and its persisted draft are left alone: the composer hides the
 * field while this shows and puts it back when the card changes or closes, so
 * whatever the operator had written is exactly what they find again.
 */
export function FirstPromptGhost(): JSX.Element {
  const reducedMotion = useReducedMotion()
  const [typed, setTyped] = useState(reducedMotion ? DEMO_TEXT.length : 0)
  useEffect(() => {
    if (reducedMotion) {
      setTyped(DEMO_TEXT.length)
      return
    }
    const timer = setInterval(() => {
      setTyped((count) => {
        if (count >= DEMO_TEXT.length) clearInterval(timer)
        return Math.min(DEMO_TEXT.length, count + 1)
      })
    }, TYPE_MS)
    return () => clearInterval(timer)
  }, [reducedMotion])
  let offset = 0
  return (
    <div
      data-testid="first-prompt-ghost"
      aria-label={DEMO_TEXT}
      role="img"
      className="cold-start-input first-prompt-ghost text-text-strong"
    >
      {FIRST_PROMPT_DEMO.map(({ part, text }, index) => {
        const start = offset
        offset += text.length + 1
        const shown = text.slice(0, Math.max(0, typed - start))
        if (!shown) return null
        return (
          <span key={part}>
            {index > 0 && ' '}
            <mark data-part={part}>{shown}</mark>
          </span>
        )
      })}
      {!reducedMotion && <span className="first-prompt-caret" aria-hidden="true" />}
    </div>
  )
}

function FirstPromptLegend(): JSX.Element {
  return (
    <ul className="first-prompt-legend">
      <li data-part="what">What</li>
      <li data-part="who">Who does it</li>
      <li data-part="when">When to ask you</li>
    </ul>
  )
}

/** Moment 1's two cards. Copy is the First Flights spec's, word for word. */
export function firstPromptCards({
  setGhost,
  setShowing,
  focusComposer,
}: {
  setGhost(on: boolean): void
  /** Whether either card is up. Advancing hides one and shows the next in one batch. */
  setShowing(on: boolean): void
  focusComposer(): void
}): TipCard[] {
  return [
    {
      anchor: FIRST_PROMPT_ANCHOR,
      title: 'Aim high.',
      body: 'Say what you want and how to run it. Agents follow your plan.',
      extra: <FirstPromptLegend />,
      onShow: () => {
        setShowing(true)
        setGhost(true)
      },
      onHide: () => {
        setGhost(false)
        setShowing(false)
      },
    },
    {
      anchor: FIRST_PROMPT_ANCHOR,
      title: 'Or start small.',
      body: 'One line is enough. Shape it in the chat as you go.',
      cta: { label: 'Write my task', onClick: focusComposer },
      onShow: () => setShowing(true),
      onHide: () => setShowing(false),
    },
  ]
}
