import { type AskQuestion, isChosenOption, parseAskQuestions } from '@podium/client-core/viewmodels'
import { CircleHelp } from 'lucide-react'
import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import type { ChatBlock } from './chat'

/**
 * The agent asking the human (AskUserQuestion) — the transcript's decision
 * surface, and a deliberate sibling of `OfferBar`: same signal frame, same mono
 * "needs you" eyebrow, same 26px primary confirm. The two are the only places an
 * agent asks the operator for something, so they read as one component family.
 *
 * Two modes:
 *  - `livePending`: the latest unanswered question on a live session. Options are
 *    clickable; a click submits the chosen 1-based option index(es) through the
 *    server, which types the matching digit(s) into the agent's native selector
 *    menu (the native terminal is unmounted in chat mode, so this is the only
 *    route to the prompt). After submit the card shows an optimistic selection +
 *    a sending spinner and disables further clicks; the agent's tailed-back
 *    result then reconciles it to the read-only highlight.
 *  - otherwise (historical / already-answered / parked): read-only, with the
 *    chosen option highlighted from the tool result text.
 *
 * ONE QUESTION AT A TIME (POD-594). A multi-question ask used to render every
 * question stacked — nine equally-weighted boxes for a three-question ask, a card
 * taller than the viewport, and a signal frame whose two edges were never on
 * screen together. The tool's own `header` field is a ≤12-character chip by
 * contract, so it becomes a rail of tabs: every question stays visible and
 * jumpable while only the open one spends vertical space.
 *
 * WHEN A CLICK COMMITS. A lone single-select question submits on click, matching
 * the native menu behind it (which commits the instant the option number is
 * pressed). Anything larger — several questions, or a multi-select — collects the
 * set and sends on one explicit press, so revising an earlier answer can never
 * fire the send.
 */

/** Agents are told to write "(Recommended)" into the label (that is the tool's
 *  own guidance), so it arrives as text. Lift it out to a chip and render the
 *  label clean — the raw label is still what the result text is matched on. */
const REC_RE = /\s*\((?:recommended|recommendation)\)\s*$/i

function splitRecommendation(label: string): { text: string; recommended: boolean } {
  const text = label.replace(REC_RE, '')
  return { text: text.trim() === '' ? label : text, recommended: REC_RE.test(label) }
}

/** The rail's tab name: the tool's short `header`, else a positional fallback. */
const tabName = (q: AskQuestion, qi: number): string => q.header?.trim() || `Q${qi + 1}`

export function AskUserQuestionCard({
  block,
  cls,
  index,
  livePending,
  onAnswer,
}: {
  block: ChatBlock
  cls: string
  index: number
  livePending: boolean
  onAnswer: (choices: { optionIndices: number[] }[]) => Promise<void>
}): JSX.Element {
  const { item } = block
  const questions: AskQuestion[] = parseAskQuestions(item.toolInputJson)
  // The answer arrives as: …"<question>"="<chosen label>"… — match per option.
  const answer = block.result ?? item.toolResult ?? ''
  const isChosen = (label: string) => isChosenOption(answer, label)

  // Local answer state for a live question. `picks[qi]` is the set of selected
  // 0-based option indices for question qi. Multi-select toggles; single-select
  // replaces. Once submitted we lock the card and wait for the transcript to
  // reconcile (which turns it back into a read-only highlight).
  const [picks, setPicks] = useState<Record<number, Set<number>>>({})
  const [submitState, setSubmitState] = useState<'idle' | 'sending' | 'failed'>('idle')
  const [step, setStep] = useState(0)
  const optionsRef = useRef<HTMLDivElement | null>(null)
  // Set whenever WE move the step. Focus follows the card to the new question so
  // the keyboard route survives the advance — but never on mount, which would
  // steal focus from the composer the moment a question arrives.
  const followFocus = useRef(false)
  const locked = submitState === 'sending' || !livePending

  // biome-ignore lint/correctness/useExhaustiveDependencies: `step` is the trigger, not a read
  useEffect(() => {
    if (!followFocus.current) return
    followFocus.current = false
    const first = optionsRef.current?.querySelector<HTMLElement>('button[role]')
    first?.focus()
  }, [step])

  const goToStep = (qi: number) => {
    followFocus.current = true
    setStep(qi)
  }

  const answered = (qi: number) => (picks[qi]?.size ?? 0) > 0
  const allAnswered = questions.length > 0 && questions.every((_, qi) => answered(qi))
  const remaining = questions.filter((_, qi) => !answered(qi)).length
  // A lone single-select commits on click like the native menu; every larger
  // shape waits for an explicit press.
  const commitsOnClick = questions.length === 1 && !questions[0]?.multiSelect
  const current = questions[Math.min(step, Math.max(questions.length - 1, 0))]
  const currentIndex = Math.min(step, Math.max(questions.length - 1, 0))

  const submit = async (next: Record<number, Set<number>>) => {
    // One choice entry per question, in order, with 1-based option indices.
    const choices = questions.map((_, qi) => ({
      optionIndices: [...(next[qi] ?? new Set<number>())].sort((a, b) => a - b).map((oi) => oi + 1),
    }))
    if (choices.some((c) => c.optionIndices.length === 0)) return // not every question answered yet
    setSubmitState('sending')
    try {
      await onAnswer(choices)
    } catch {
      setSubmitState('failed')
    }
  }

  const onOptionClick = (q: AskQuestion, qi: number, oi: number) => {
    if (locked) return
    const cur = new Set(picks[qi])
    if (q.multiSelect) {
      // Toggle within the question; the user confirms the set with the button.
      if (cur.has(oi)) cur.delete(oi)
      else cur.add(oi)
    } else {
      cur.clear()
      cur.add(oi)
    }
    const next = { ...picks, [qi]: cur }
    setPicks(next)
    if (commitsOnClick) {
      void submit(next)
      return
    }
    // Several questions: step to the next one still waiting on an answer, and
    // stay put once they are all answered so the send press stays deliberate.
    if (!q.multiSelect && questions.length > 1) {
      const nextOpen = questions.findIndex((_, i) => (next[i]?.size ?? 0) === 0)
      if (nextOpen !== -1 && nextOpen !== qi) goToStep(nextOpen)
    }
  }

  /** Number keys pick, arrows move, Enter sends — the mechanism behind this card
   *  is literally digits typed into a menu, so the keys are the honest route. */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (locked || !current) return
    const buttons = () => [...(optionsRef.current?.querySelectorAll('button[role]') ?? [])]
    if (/^[1-9]$/.test(e.key)) {
      const oi = Number(e.key) - 1
      if (oi < current.options.length) {
        e.preventDefault()
        onOptionClick(current, currentIndex, oi)
      }
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const list = buttons()
      if (list.length === 0) return
      e.preventDefault()
      const at = list.indexOf(document.activeElement as Element)
      const delta = e.key === 'ArrowDown' ? 1 : -1
      const next = list[(at + delta + list.length) % list.length]
      ;(next as HTMLElement | undefined)?.focus()
      return
    }
    if (e.key === 'Enter' && !commitsOnClick && allAnswered) {
      e.preventDefault()
      void submit(picks)
    }
  }

  // Flat Field (POD-159): an ANSWERED question collapses to a one-line receipt
  // (question + chosen option) so past decisions stay auditable without spending
  // attention. Nothing is asked of the operator any more, so nothing here may
  // carry the signal colour.
  if (!livePending && answer.trim() !== '' && questions.length > 0) {
    return (
      <div className={cn(cls)} data-block={index} data-testid="ask-receipt">
        <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
        <div className="transcript-body flex flex-col gap-1 py-0.5">
          {questions.map((q, qi) => {
            const chosen = q.options
              .filter((o) => isChosen(o.label))
              .map((o) => splitRecommendation(o.label).text)
            return (
              <div
                key={`${q.header ?? q.question}-${qi}`}
                className="flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground"
              >
                <span className="tool-glyph flex-none" aria-hidden="true">
                  ✓
                </span>
                <span className="min-w-0 truncate" title={q.question}>
                  {q.question}
                </span>
                <span className="flex-none rounded-[5px] border border-border px-[7px] text-[11px] font-medium text-foreground">
                  {chosen.length > 0 ? chosen.join(', ') : 'answered'}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // Read-only (parked, or historical without a parseable result): a record of
  // what was asked, not a control. Quiet frame, no key caps, no signal colour.
  const readOnly = !livePending

  return (
    <div className={cn(cls)} data-block={index}>
      <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
      <div
        data-testid={readOnly ? 'ask-readonly' : 'ask-live'}
        aria-busy={submitState === 'sending' || undefined}
        className={cn(
          'transcript-body',
          'rounded-[10px] border px-3.5 py-2.5',
          readOnly
            ? 'border-border'
            : // A pending question is the turn's single "needs you" surface — it
              // owns the signal colour while it is live, like the offer bar.
              'border-primary/40 bg-primary/[0.05]',
        )}
      >
        <div className="flex min-h-[15px] items-center gap-2.5">
          <span
            className={cn(
              'flex items-center gap-1.5 font-mono text-[8.5px] font-medium tracking-[0.12em] uppercase',
              readOnly ? 'text-muted-foreground/80' : 'text-primary',
            )}
          >
            <CircleHelp size={11} aria-hidden="true" />
            {readOnly ? 'Question · not answered' : 'Question · needs you'}
          </span>
          {submitState === 'sending' && (
            <span className="ml-auto flex items-center gap-1.5 font-mono text-[9px] tracking-[0.06em] text-muted-foreground">
              <span className="spb" aria-hidden="true" />
              sending
            </span>
          )}
          {submitState === 'failed' && (
            <span
              role="alert"
              className="ml-auto font-mono text-[9px] tracking-[0.06em] text-destructive"
            >
              not delivered — choose again
            </span>
          )}
          {submitState === 'idle' && questions.length > 1 && (
            <span className="ml-auto font-mono text-[9px] tracking-[0.06em] text-muted-foreground/70 tabular-nums">
              {currentIndex + 1} / {questions.length}
            </span>
          )}
        </div>

        {/* The rail: every question stays reachable, only one is open. */}
        {questions.length > 1 && (
          <div className="mt-1.5 flex flex-wrap gap-[3px]">
            {questions.map((q, qi) => (
              <button
                key={`${tabName(q, qi)}-${qi}`}
                type="button"
                aria-current={qi === currentIndex ? 'step' : undefined}
                onClick={() => goToStep(qi)}
                className={cn(
                  'inline-flex h-5 items-center gap-1.5 rounded-[5px] border border-transparent px-[7px]',
                  'font-mono text-[9px] font-medium tracking-[0.08em] uppercase transition-colors',
                  qi === currentIndex
                    ? 'border-input bg-chip text-foreground'
                    : answered(qi)
                      ? 'text-muted-foreground hover:bg-foreground/[0.04]'
                      : 'text-muted-foreground/60 hover:bg-foreground/[0.04] hover:text-foreground',
                )}
              >
                {answered(qi) && (
                  <span className="text-[9px] leading-none text-primary" aria-hidden="true">
                    ✓
                  </span>
                )}
                {tabName(q, qi)}
              </button>
            ))}
          </div>
        )}

        {questions.length === 0 && (
          <div className="mt-1.5 text-xs text-muted-foreground">
            AskUserQuestion (unparseable input)
          </div>
        )}

        {/* Read-only shows every question; live shows the open one. */}
        {(readOnly ? questions : current ? [current] : []).map((q, i) => {
          const qi = readOnly ? i : currentIndex
          return (
            <div key={`${tabName(q, qi)}-${qi}`} className={readOnly && i > 0 ? 'mt-3.5' : ''}>
              {readOnly && q.header && (
                <div className="mt-2 font-mono text-[9px] font-medium tracking-[0.08em] text-muted-foreground/70 uppercase">
                  {q.header}
                </div>
              )}
              <div
                className={cn(
                  'max-w-[84ch] text-[13px] leading-[1.4]',
                  readOnly && q.header ? 'mt-0.5' : 'mt-2',
                  readOnly ? 'font-medium text-muted-foreground' : 'font-semibold text-foreground',
                )}
              >
                {q.question}
              </div>
              <div
                ref={readOnly ? undefined : optionsRef}
                role={q.multiSelect ? 'group' : 'radiogroup'}
                aria-label={q.question}
                className="mt-1.5 flex flex-col gap-px"
                // The keys live on the option group rather than the card: focus
                // follows the card here on every advance, so this is where the
                // operator's hands already are.
                onKeyDown={readOnly ? undefined : onKeyDown}
              >
                {q.options.map((o, oi) => {
                  // Live: highlight the operator's local pick. Read-only:
                  // highlight the option the agent's result says was chosen.
                  const chosen = readOnly ? isChosen(o.label) : (picks[qi]?.has(oi) ?? false)
                  const { text, recommended } = splitRecommendation(o.label)
                  const body = (
                    <>
                      <span
                        aria-hidden="true"
                        className={cn(
                          'row-span-2 mt-px flex size-4 items-center justify-center font-mono text-[9.5px] font-medium tabular-nums',
                          q.multiSelect ? 'rounded-[3px]' : 'rounded-[4px]',
                          readOnly
                            ? chosen
                              ? 'text-primary'
                              : 'text-muted-foreground/60'
                            : chosen
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-foreground/[0.06] text-muted-foreground',
                        )}
                      >
                        {chosen ? '✓' : oi + 1}
                      </span>
                      <span className="flex min-w-0 flex-wrap items-baseline gap-x-[7px]">
                        <span
                          className={cn(
                            'text-[12.5px] leading-[1.35]',
                            chosen
                              ? 'font-semibold text-foreground'
                              : readOnly
                                ? 'font-medium text-muted-foreground'
                                : 'font-medium text-foreground',
                          )}
                        >
                          {text}
                        </span>
                        {recommended && (
                          <span className="inline-flex h-3.5 flex-none items-center rounded-[4px] border border-border px-[5px] font-mono text-[8px] font-medium tracking-[0.1em] text-muted-foreground uppercase">
                            rec
                          </span>
                        )}
                      </span>
                      {o.description && (
                        <span className="col-start-2 mt-px max-w-[76ch] text-[11.5px] leading-[1.45] text-muted-foreground">
                          {o.description}
                        </span>
                      )}
                    </>
                  )
                  const baseCls = 'grid grid-cols-[16px_1fr] gap-x-2.5 rounded-[7px] text-left'
                  return readOnly ? (
                    <div
                      key={`${o.label}-${oi}`}
                      className={cn(baseCls, 'px-2 py-1.5', chosen && 'bg-primary/[0.08]')}
                    >
                      {body}
                    </div>
                  ) : (
                    <button
                      data-pressable
                      key={`${o.label}-${oi}`}
                      type="button"
                      role={q.multiSelect ? 'checkbox' : 'radio'}
                      aria-checked={chosen}
                      disabled={locked}
                      aria-busy={submitState === 'sending' || undefined}
                      onClick={() => onOptionClick(q, qi, oi)}
                      className={cn(
                        baseCls,
                        'w-full border border-transparent px-2 pt-1.5 pb-[7px] transition-colors',
                        chosen && 'border-primary/35 bg-primary/[0.08]',
                        locked
                          ? cn('cursor-default', !chosen && 'opacity-40')
                          : 'cursor-pointer hover:bg-foreground/[0.038]',
                      )}
                    >
                      {body}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}

        {/* Several questions, or a multi-select: the set is sent on one press. */}
        {livePending && questions.length > 0 && !commitsOnClick && (
          <div className="mt-2.5 flex items-center gap-2.5">
            <button
              data-pressable
              type="button"
              disabled={locked || !allAnswered}
              aria-busy={submitState === 'sending' || undefined}
              onClick={() => void submit(picks)}
              className="h-[26px] rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-85 disabled:cursor-default disabled:opacity-40"
            >
              {questions.length > 1 ? 'Send answers' : 'Send answer'}
            </button>
            <span className="font-mono text-[9px] tracking-[0.05em] text-muted-foreground/70">
              {questions.length > 1 && remaining > 0 ? `${remaining} left · ` : ''}
              {current?.multiSelect ? 'digits toggle' : 'digits choose'} · ↵ send
            </span>
          </div>
        )}
        {livePending && commitsOnClick && (
          <div className="mt-2 font-mono text-[9px] tracking-[0.05em] text-muted-foreground/70">
            digits choose · ↑↓ move
          </div>
        )}
      </div>
    </div>
  )
}
