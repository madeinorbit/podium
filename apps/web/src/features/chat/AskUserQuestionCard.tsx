import { type AskQuestion, isChosenOption, parseAskQuestions } from '@podium/client-core/viewmodels'
import type { JSX } from 'react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { ChatBlock } from './chat'

/**
 * The agent asking the human (AskUserQuestion) — render the question(s) and
 * options as a readable card instead of a collapsed tool row.
 *
 * Two modes:
 *  - `livePending`: the latest unanswered question on a live session. Options are
 *    clickable; a click submits the chosen 1-based option index(es) through the
 *    server, which types the matching digit(s) into the agent's native selector
 *    menu (the native terminal is unmounted in chat mode, so this is the only
 *    route to the prompt). After submit the card shows an optimistic selection +
 *    "Answer sent" and disables further clicks; the agent's tailed-back result
 *    then reconciles it to the read-only highlight.
 *  - otherwise (historical / already-answered / parked): read-only, with the
 *    chosen option highlighted from the tool result text.
 *
 * NEEDS IN-BROWSER VERIFICATION against a real Claude prompt: the exact key the
 * AskUserQuestion TUI accepts is documented (single-select commits on the option
 * number key; multi-select takes comma-separated numbers + Enter) but not yet
 * confirmed live here.
 */
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
  // submits on the first click. Once submitted we lock the card and wait for the
  // transcript to reconcile (which turns it back into a read-only highlight).
  const [picks, setPicks] = useState<Record<number, Set<number>>>({})
  const [submitState, setSubmitState] = useState<'idle' | 'sending' | 'failed'>('idle')
  const locked = submitState === 'sending' || !livePending

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
    setPicks((prev) => {
      const cur = new Set(prev[qi])
      if (q.multiSelect) {
        // Toggle within the question; the user confirms the set with the button.
        if (cur.has(oi)) cur.delete(oi)
        else cur.add(oi)
      } else {
        cur.clear()
        cur.add(oi)
      }
      const next = { ...prev, [qi]: cur }
      // Single-select with a single question → submit immediately (matches the
      // native menu, which commits the instant the option number is pressed).
      const allSingle = questions.every((qq) => !qq.multiSelect)
      const allAnswered = questions.every((_, i) => (next[i]?.size ?? 0) > 0)
      if (allSingle && allAnswered) void submit(next)
      return next
    })
  }

  // A live multi-select (or multi-question) card needs an explicit confirm: the
  // user toggles options, then submits the whole set in one go.
  const needsConfirmButton =
    livePending && submitState !== 'sending' && questions.some((q) => q.multiSelect)
  const allAnswered = questions.length > 0 && questions.every((_, qi) => (picks[qi]?.size ?? 0) > 0)

  // Flat Field (POD-159): an ANSWERED question collapses to a one-line receipt
  // (question + chosen option) so past decisions stay auditable without
  // spending attention. Pending/unanswered cards keep the full form.
  if (!livePending && answer.trim() !== '' && questions.length > 0) {
    return (
      <div className={cn(cls)} data-block={index} data-testid="ask-receipt">
        <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
        <div className="transcript-body flex flex-col gap-1 py-0.5">
          {questions.map((q, qi) => {
            const chosen = q.options.filter((o) => isChosen(o.label)).map((o) => o.label)
            return (
              <div
                key={`${q.header ?? q.question}-${qi}`}
                className="flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground"
              >
                <span className="tool-glyph flex-none" aria-hidden="true">
                  ?
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

  return (
    <div className={cn(cls)} data-block={index}>
      <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
      {/* A pending question is a "needs you" surface — it earns the signal
          frame; a parked/unparseable one stays a quiet read-only block. */}
      <div
        className={cn(
          'transcript-body',
          livePending && 'rounded-lg border border-primary/45 bg-primary/[0.04] px-3.5 py-2.5',
        )}
      >
        <div className="transcript-header">
          <span className="transcript-role transcript-role--answer">Question for you</span>
          {livePending && submitState === 'sending' && (
            <span className="transcript-meta">answer sent…</span>
          )}
          {livePending && submitState === 'failed' && (
            <span className="transcript-meta text-destructive">not delivered</span>
          )}
        </div>
        <div className="mt-1.5 flex flex-col gap-3">
          {questions.map((q, qi) => (
            <div key={`${q.header ?? q.question}-${qi}`}>
              {q.header && (
                <div className="mb-0.5 text-[10px] uppercase tracking-[0.06em] text-muted-foreground/70">
                  {q.header}
                </div>
              )}
              <div className="text-sm font-medium text-foreground">{q.question}</div>
              <div className="mt-2 flex flex-col gap-1">
                {q.options.map((o, oi) => {
                  // Pending: highlight the user's local pick. Read-only: highlight
                  // the option the agent's result says was chosen.
                  const picked = (picks[qi]?.has(oi) ?? false) && livePending
                  const chosen = livePending ? picked : isChosen(o.label)
                  const body = (
                    <>
                      <span className="font-medium text-foreground">
                        {chosen ? '✓ ' : livePending ? `${oi + 1}. ` : ''}
                        {o.label}
                      </span>
                      {o.description && (
                        <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground/80">
                          {o.description}
                        </span>
                      )}
                    </>
                  )
                  const baseCls = cn(
                    'rounded-md border px-2.5 py-1.5 text-left text-xs',
                    chosen
                      ? 'border-primary/50 bg-primary/[0.08] text-foreground'
                      : 'border-border text-muted-foreground',
                  )
                  // Only the live pending card gets clickable controls; everything
                  // else stays a plain read-only row.
                  return livePending ? (
                    <button
                      key={`${o.label}-${oi}`}
                      type="button"
                      disabled={locked}
                      onClick={() => onOptionClick(q, qi, oi)}
                      className={cn(
                        baseCls,
                        'transition-colors',
                        locked
                          ? 'cursor-default'
                          : 'cursor-pointer hover:border-primary/60 hover:bg-primary/[0.12]',
                      )}
                    >
                      {body}
                    </button>
                  ) : (
                    <div key={`${o.label}-${oi}`} className={baseCls}>
                      {body}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
          {needsConfirmButton && (
            <button
              type="button"
              disabled={!allAnswered}
              onClick={() => void submit(picks)}
              className="mt-1 self-start rounded-md border border-primary/50 bg-primary/[0.12] px-3 py-1.5 text-xs font-medium text-foreground hover:bg-primary/20 disabled:cursor-default disabled:opacity-50"
            >
              Submit answer
            </button>
          )}
          {questions.length === 0 && (
            <div className="text-xs text-muted-foreground">AskUserQuestion (unparseable input)</div>
          )}
        </div>
      </div>
    </div>
  )
}
