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
import { ChevronDown, Mail as MailIcon } from 'lucide-react'
import type { JSX, MouseEvent as ReactMouseEvent } from 'react'
import { useMemo, useState } from 'react'
import { MessageEnvelopeGroup } from './MessageEnvelopeGroup'
import { clockLabel, fullTimeLabel, parseTs } from './transcript-time'

export function SentNoteRow({
  note,
  fallbackId,
  className,
  blockIndex,
  ts,
  onBodyClick,
  forceOpen,
}: {
  note: Extract<ToolMail, { op: 'note' }>
  /** Keys the item while the send is still running and has no id. */
  fallbackId: string
  className: string
  blockIndex: number
  ts: string | undefined
  onBodyClick: (e: ReactMouseEvent) => void
  forceOpen: boolean
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
      ts={ts}
      onBodyClick={onBodyClick}
      forceOpen={forceOpen}
      direction="to"
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
}: {
  /** How many notes the read listed, when its output said. */
  notes: number | undefined
  result: string | undefined
  className: string
  blockIndex: number
  rowKey: string
  ts: string | undefined
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const label =
    notes === undefined ? 'Read notes' : `Read ${notes === 1 ? '1 note' : `${notes} notes`}`
  const stamp = parseTs(ts)
  return (
    <div
      className={className}
      data-block={blockIndex}
      data-row-key={rowKey}
      data-internal-message="true"
      data-testid="inbox-read"
    >
      <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
      <div className="transcript-body">
        <div className="mail-group" data-open={open ? 'true' : 'false'}>
          <button
            data-pressable
            type="button"
            className="mail-fold"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <MailIcon className="mail-fold-icon" size={13} aria-hidden="true" />
            <span className="mail-fold-count">{label}</span>
            {stamp && (
              <time className="mail-fold-meta" dateTime={ts} title={fullTimeLabel(stamp)}>
                · {clockLabel(stamp)}
              </time>
            )}
            <span className="mail-fold-gap" />
            <ChevronDown className="mail-fold-chev" size={14} aria-hidden="true" />
          </button>
          {open && <pre className="tool-result-full">{result ?? '(no result captured)'}</pre>}
        </div>
      </div>
    </div>
  )
}
