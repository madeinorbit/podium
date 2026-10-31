/**
 * THE AGENT'S OWN MAIL, AS MAIL (POD-2146).
 *
 * An agent mails with the CLI, so what it sent used to read as a shell command
 * in its own chat. A send or reply now folds like the notes it receives — "Note
 * to POD-2128 · 14:02" — and opening it fetches the body by the id the CLI
 * printed, so nothing is fetched until a reader asks. An inbox read is a quiet
 * "Read 3 notes" line with the raw listing behind it. The compute path decides
 * all of it (`presentToolBlock`); these rows only read the block's `mail`.
 */
import type { ParsedEnvelope, ToolMail } from '@podium/client-core/values'
import type { JSX, MouseEvent as ReactMouseEvent } from 'react'
import { useMemo, useState } from 'react'
import { MessageEnvelopeGroup } from './MessageEnvelopeGroup'
import { clockLabel, fullTimeLabel, parseTs } from './transcript-time'
import { WorkGlyph } from './WorkGlyph'

export function SentNoteRow({
  note,
  fallbackId,
  className,
  blockIndex,
  ts,
  onBodyClick,
  forceOpen,
  bare = false,
}: {
  note: Extract<ToolMail, { op: 'note' }>
  /** Keys the item while the send is still running and has no id. */
  fallbackId: string
  className?: string
  blockIndex?: number
  ts: string | undefined
  onBodyClick: (e: ReactMouseEvent) => void
  forceOpen: boolean
  bare?: boolean
}): JSX.Element {
  const envelopes = useMemo(
    (): ParsedEnvelope[] => [
      {
        id: note.id ?? fallbackId,
        from: '',
        to: note.to,
        body: note.preview ?? '',
        question: false,
        expectsReply: false,
        // With an id the body is fetched when the card opens; before it, the
        // preview is all there is.
        ...(note.id ? { pointer: 'by-id' as const } : {}),
      },
    ],
    [note, fallbackId],
  )
  return (
    <MessageEnvelopeGroup
      envelopes={envelopes}
      className={className}
      blockIndex={blockIndex}
      rowKey={fallbackId}
      ts={ts}
      onBodyClick={onBodyClick}
      forceOpen={forceOpen}
      direction="to"
      bare={bare}
    />
  )
}

export function InboxReadRow({
  notes,
  result,
  className,
  blockIndex,
  rowKey,
  ts,
  bare = false,
  forceOpen = false,
}: {
  /** How many notes the read listed, when its output said. */
  notes: number | undefined
  result: string | undefined
  className?: string
  blockIndex?: number
  rowKey: string
  ts: string | undefined
  bare?: boolean
  forceOpen?: boolean
}): JSX.Element {
  const [userOpen, setOpen] = useState(false)
  const open = userOpen || forceOpen
  const label =
    notes === undefined ? 'Read notes' : `Read ${notes === 1 ? '1 note' : `${notes} notes`}`
  const stamp = bare ? parseTs(ts) : undefined
  const content = (
    <div
      className="work-line mail-group"
      data-open={open ? 'true' : 'false'}
      data-transcript-retain={userOpen ? '' : undefined}
      data-transcript-run-view={forceOpen && !userOpen ? '' : undefined}
    >
      {stamp && (
        <time className="quiet-time" dateTime={ts} title={fullTimeLabel(stamp)}>
          {clockLabel(stamp)}
        </time>
      )}
      <button
        data-pressable
        type="button"
        className="work-line-row mail-fold"
        data-transcript-run-toggle={forceOpen && !userOpen ? '' : undefined}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="work-line-glyph" aria-hidden="true">
          <WorkGlyph mail />
        </span>
        <span className="work-line-phrase">{label}</span>
      </button>
      {open && <pre className="tool-result-full">{result ?? '(no result captured)'}</pre>}
    </div>
  )
  return bare ? (
    content
  ) : (
    <div
      className={className}
      data-block={blockIndex}
      data-row-key={rowKey}
      data-internal-message="true"
      data-testid="inbox-read"
    >
      <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
      <div className="transcript-body">{content}</div>
    </div>
  )
}
