/**
 * THE AGENT'S OWN MAIL, AS MAIL (POD-2146).
 *
 * An agent mails with the CLI, so what it sent used to read as a shell command
 * in its own chat. A send or reply now folds like the notes it receives — "Note
 * to POD-2128 · 14:02" — and opening it fetches the body by the id the CLI
 * printed, so nothing is fetched until a reader asks. An inbox read is a quiet
 * "Read 3 notes" line with the raw listing behind it. A send that failed is not
 * mail and stays an ordinary error row (see ChatBlockView).
 */
import type { ParsedEnvelope } from '@podium/client-core/values'
import type { MailCommand } from '@podium/commands/mail-command'
import { countInboxNotes, mailRecipientLabel, parseMailSent } from '@podium/commands/mail-command'
import { ChevronDown, Mail as MailIcon } from 'lucide-react'
import type { JSX, MouseEvent as ReactMouseEvent } from 'react'
import { useMemo, useState } from 'react'
import { MessageEnvelopeGroup } from './MessageEnvelopeGroup'
import { clockLabel, fullTimeLabel, parseTs } from './transcript-time'

/** The note a send or reply created, or null when its output names none —
 *  which, once there is output, means it did not go out. */
export function sentNoteEnvelope(
  mail: Exclude<MailCommand, { op: 'inbox' }>,
  result: string | undefined,
  fallbackId: string,
): ParsedEnvelope | null {
  const sent = result ? parseMailSent(result) : null
  if (result?.trim() && !sent) return null
  const to =
    mail.op === 'send'
      ? mail.to
      : sent?.to !== undefined
        ? mailRecipientLabel(sent.to)
        : 'the sender'
  return {
    // Still running: the note has no id yet, only what the command said.
    id: sent?.id ?? fallbackId,
    from: '',
    to,
    body: mail.preview ?? '',
    question: false,
    expectsReply: false,
    ...(sent ? { pointer: 'by-id' as const } : {}),
  }
}

export function SentNoteRow({
  envelope,
  className,
  blockIndex,
  ts,
  onBodyClick,
  forceOpen,
}: {
  envelope: ParsedEnvelope
  className: string
  blockIndex: number
  ts: string | undefined
  onBodyClick: (e: ReactMouseEvent) => void
  forceOpen: boolean
}): JSX.Element {
  const envelopes = useMemo(() => [envelope], [envelope])
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
  result,
  className,
  blockIndex,
  rowKey,
  ts,
}: {
  result: string | undefined
  className: string
  blockIndex: number
  rowKey: string
  ts: string | undefined
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const count = useMemo(() => (result ? countInboxNotes(result) : undefined), [result])
  const label =
    count === undefined ? 'Read notes' : `Read ${count === 1 ? '1 note' : `${count} notes`}`
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
