/**
 * ONE ASK OF A CONCERTMASTER (POD-7211): something its agent needs from its
 * person. A question takes an answer in words, a decision takes one of its
 * options (or other words), a to-do is marked done.
 *
 * ONE CARD, TWO PLACES. An ask is drawn inline in the curated chat, where it
 * was asked, and in the Concertmaster dock panel's "Needs you" list, where it
 * stays in view after the chat has moved on. Both draw this component over the
 * same record, so settling it in either place settles it in both.
 *
 * AN OPEN ASK OWNS THE SIGNAL COLOUR, like a live question and the offer bar:
 * it is the thing that needs you. A settled one is a quiet line that keeps
 * what was asked and what it was settled with.
 */

import type { ConcertmasterEntryModel } from '@podium/client-graph/models'
import { observer } from '@podium/client-graph/react'
import { concertmasterAskNoun } from '@podium/model/browser'
import { Check, CircleHelp, ListTodo, Split, Undo2, X } from 'lucide-react'
import { type JSX, type KeyboardEvent, useId, useState } from 'react'
import { cn } from '@/lib/utils'
import { clockLabel, fullTimeLabel } from '../transcript-time'

/** What settling an ask asks of its host. Answers whether it was settled now. */
export type RespondToAsk = (
  entry: ConcertmasterEntryModel,
  response: 'answered' | 'done' | 'dismissed',
  text?: string,
) => Promise<boolean>

type Phase = 'idle' | 'sending' | 'failed'

const KIND_GLYPH = { question: CircleHelp, decision: Split, todo: ListTodo } as const

function glyphOf(askKind: string | undefined): typeof CircleHelp {
  return askKind === 'decision' || askKind === 'todo' ? KIND_GLYPH[askKind] : KIND_GLYPH.question
}

/** "Decision", "Question", "To-do": the ask kind as a label. */
function kindLabel(askKind: string | undefined): string {
  const noun = concertmasterAskNoun(askKind)
  return noun.charAt(0).toUpperCase() + noun.slice(1)
}

function clockOf(iso: string | undefined): { label: string; title: string } | null {
  if (!iso) return null
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? null : { label: clockLabel(at), title: fullTimeLabel(at) }
}

/** How a settled ask reads: the verdict, and whose it was. */
function settledWords(entry: ConcertmasterEntryModel): string {
  const byAgent = entry.settledBy === 'agent'
  switch (entry.status) {
    case 'answered':
      return byAgent ? 'Answered in chat' : entry.askKind === 'decision' ? 'Decided' : 'Answered'
    case 'done':
      return 'Done'
    case 'dismissed':
      return 'Dismissed'
    case 'retracted':
      return 'Withdrawn'
    default:
      return entry.status ?? 'Settled'
  }
}

const SettledAsk = observer(function SettledAsk({
  entry,
  dock,
}: {
  entry: ConcertmasterEntryModel
  dock: boolean
}): JSX.Element {
  const withdrawn = entry.status === 'retracted' || entry.status === 'dismissed'
  const Glyph = entry.status === 'retracted' ? Undo2 : entry.status === 'dismissed' ? X : Check
  const settled = clockOf(entry.settledAt)
  return (
    <div
      data-testid="concertmaster-ask"
      data-ask-status={entry.status}
      className={cn('cm-ask cm-ask--settled', dock && 'cm-ask--dock')}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="tool-glyph flex-none translate-y-[2px]" aria-hidden="true">
          <Glyph size={12} strokeWidth={1.8} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="text-muted-foreground">
            {settledWords(entry)} · {kindLabel(entry.askKind).toLowerCase()} #{entry.number}
          </span>
          <span
            className={cn(
              'ml-2 text-foreground',
              withdrawn && 'text-muted-foreground line-through decoration-text-faint',
            )}
          >
            {entry.body}
          </span>
        </span>
        {settled && (
          <time className="chat-clk flex-none" dateTime={entry.settledAt} title={settled.title}>
            {settled.label}
          </time>
        )}
      </div>
      {entry.answer && (
        <p className="cm-ask-answer" data-testid="concertmaster-ask-answer">
          {entry.answer}
        </p>
      )}
    </div>
  )
})

const OpenAsk = observer(function OpenAsk({
  entry,
  dock,
  onRespond,
}: {
  entry: ConcertmasterEntryModel
  dock: boolean
  onRespond: RespondToAsk
}): JSX.Element {
  const fieldId = useId()
  const [phase, setPhase] = useState<Phase>('idle')
  const [text, setText] = useState('')
  // A decision shows its options; "Other" opens the field for different words.
  const [other, setOther] = useState(false)
  const kind = entry.askKind === 'decision' || entry.askKind === 'todo' ? entry.askKind : 'question'
  const options = entry.options ?? []
  const locked = phase === 'sending'
  const Glyph = glyphOf(kind)
  const asked = clockOf(entry.createdAt)

  const respond = (response: 'answered' | 'done' | 'dismissed', words?: string): void => {
    if (locked) return
    setPhase('sending')
    onRespond(entry, response, words).then(
      // Settled here or a moment ago elsewhere: either way the record that
      // arrives redraws this card as settled.
      () => setPhase('idle'),
      () => setPhase('failed'),
    )
  }
  const answer = (): void => {
    const words = text.trim()
    if (words) respond('answered', words)
  }
  const onFieldKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      answer()
    }
  }
  const showField = kind === 'question' || (kind === 'decision' && other)

  return (
    <div
      data-testid="concertmaster-ask"
      data-ask-status="open"
      data-ask-kind={kind}
      aria-busy={locked || undefined}
      className={cn('cm-ask cm-ask--open', dock && 'cm-ask--dock')}
    >
      <div className="flex min-h-[15px] items-center gap-2">
        <span className="flex items-center gap-1.5 font-mono shell-type-micro font-medium tracking-[0.12em] text-primary uppercase">
          <Glyph size={11} aria-hidden="true" />
          {kindLabel(kind)}
        </span>
        <span className="font-mono shell-type-micro text-muted-foreground/70 tabular-nums">
          #{entry.number}
        </span>
        {phase === 'sending' && (
          <span className="ml-auto font-mono shell-type-micro tracking-[0.06em] text-muted-foreground">
            sending
          </span>
        )}
        {phase === 'failed' && (
          <span
            role="alert"
            className="ml-auto font-mono shell-type-micro tracking-[0.06em] text-destructive"
          >
            not delivered — try again
          </span>
        )}
        {phase === 'idle' && asked && (
          <time className="chat-clk ml-auto" dateTime={entry.createdAt} title={asked.title}>
            {asked.label}
          </time>
        )}
      </div>

      <p className="cm-ask-title">{entry.body}</p>
      {entry.detail && <p className="cm-ask-detail">{entry.detail}</p>}

      {kind === 'decision' && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {options.map((option, at) => (
            <button
              data-pressable
              key={option}
              type="button"
              data-testid="concertmaster-ask-option"
              disabled={locked}
              onClick={() => respond('answered', option)}
              className={cn(
                'cm-ask-option',
                // The agent lists the one it recommends first.
                at === 0 && 'cm-ask-option--lead',
              )}
            >
              {option}
            </button>
          ))}
          {!other && (
            <button
              data-pressable
              type="button"
              disabled={locked}
              onClick={() => setOther(true)}
              className="cm-ask-quiet"
            >
              Something else…
            </button>
          )}
        </div>
      )}

      {kind === 'question' && options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {options.map((option) => (
            <button
              data-pressable
              key={option}
              type="button"
              data-testid="concertmaster-ask-option"
              disabled={locked}
              onClick={() => respond('answered', option)}
              className="cm-ask-option"
            >
              {option}
            </button>
          ))}
        </div>
      )}

      {showField && (
        <div className="mt-2 flex items-end gap-1.5">
          <label className="sr-only" htmlFor={fieldId}>
            {kind === 'decision' ? `Another answer to: ${entry.body}` : `Answer to: ${entry.body}`}
          </label>
          <textarea
            id={fieldId}
            data-testid="concertmaster-ask-text"
            rows={1}
            disabled={locked}
            value={text}
            placeholder={kind === 'decision' ? 'Say what you want instead…' : 'Type your answer…'}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onFieldKey}
            className="cm-ask-field"
          />
          <button
            data-pressable
            type="button"
            data-testid="concertmaster-ask-send"
            disabled={locked || text.trim() === ''}
            onClick={answer}
            className="cm-ask-send"
          >
            Answer
          </button>
        </div>
      )}

      <div className="mt-2 flex items-center gap-1.5">
        {kind === 'todo' && (
          <button
            data-pressable
            type="button"
            data-testid="concertmaster-ask-done"
            disabled={locked}
            onClick={() => respond('done')}
            className="cm-ask-send"
          >
            <Check size={12} strokeWidth={2} aria-hidden="true" /> Mark done
          </button>
        )}
        <button
          data-pressable
          type="button"
          data-testid="concertmaster-ask-dismiss"
          disabled={locked}
          onClick={() => respond('dismissed')}
          className="cm-ask-quiet"
          title="Tell the agent you will not act on this"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
})

/** An ask, open or settled. `dock` sets the narrower panel's density. */
export const ConcertmasterAskCard = observer(function ConcertmasterAskCard({
  entry,
  dock = false,
  onRespond,
}: {
  entry: ConcertmasterEntryModel
  dock?: boolean
  onRespond: RespondToAsk
}): JSX.Element {
  return entry.open ? (
    <OpenAsk entry={entry} dock={dock} onRespond={onRespond} />
  ) : (
    <SettledAsk entry={entry} dock={dock} />
  )
})
