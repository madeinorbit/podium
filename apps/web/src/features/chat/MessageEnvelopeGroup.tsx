/**
 * PODIUM'S OWN MAIL, FOLDED TO ONE LINE (POD-993).
 *
 * System mail is provenance. It explains why the agent did what it did next, and
 * a reader scanning a conversation needs to see THAT one arrived and from whom —
 * not the paragraph. Each frame used to be its own row with its own header, so a
 * turn that received three notes spent three rows and three headers saying almost
 * the same thing before the answer got a word in.
 *
 * The whole burst is now ONE object: a quiet tinted line reading "3 notes from
 * Podium" with the issues they came from, which opens into a card that lists them
 * — sender in a fixed left column, subject and time on one baseline, two lines of
 * the body under it. That is the shape mail has everywhere else in computing, and
 * it is the shape that lets a reader decide in one glance whether any of this is
 * for them.
 *
 * WHAT OPENS ON ARRIVAL. A frame that asks a question or requests a reply is not
 * background — it has a consequence, and folding it would hide the one kind of
 * mail that does. If any frame in the burst is consequential, the card is open
 * when it lands.
 *
 * WHAT IS NOT LOST. The card's two-line preview is a preview: clicking an item
 * opens that frame's full markdown, with its refs, code and links live. Nothing
 * in the frame is unreachable — it is just no longer in the way.
 */
import { envelopePrincipal, type ParsedEnvelope } from '@podium/client-core/viewmodels'
import { ChevronDown, Mail as MailIcon, X } from 'lucide-react'
import type { JSX, MouseEvent as ReactMouseEvent } from 'react'
import { useMemo, useState } from 'react'
import {
  type IssueReferenceLookup,
  isKnownRefPrefix,
  renderMarkdown,
  sanitizeRenderedMarkdown,
} from '@/lib/markdown'
import { clockLabel, fullTimeLabel, parseTs } from './transcript-time'

/** An envelope-header principal: the nice-id issue ref renders as the same
 *  clickable ref-link chip the markdown pass emits, so the sender/recipient are
 *  as navigable as refs in the body. Legacy `#seq` labels and sessions stay
 *  plain text. */
function PrincipalLabel({
  label,
  issueReferences,
}: {
  label: string
  issueReferences: IssueReferenceLookup
}): JSX.Element {
  const p = envelopePrincipal(label)
  const chip = p.ref !== null && isKnownRefPrefix(p.ref.split('-')[0] ?? '')
  return (
    <>
      {p.pre}
      {p.ref !== null &&
        (chip ? (
          <a
            className="ref-link ref-link--issue"
            href={`#${p.ref}`}
            data-ref={p.ref}
            data-issue-stage={issueReferences.get(p.ref)?.stage}
            data-issue-availability={issueReferences.get(p.ref)?.availability}
            aria-label={issueReferences.get(p.ref)?.accessibleLabel}
          >
            {p.ref}
          </a>
        ) : (
          p.ref
        ))}
      {p.post}
    </>
  )
}

/** The sender reduced to the thing a reader recognises: the issue ref if it has
 *  one, else the label itself. Used for the fold line's "POD-84 · POD-90" and
 *  for the card's left column. */
function senderTag(label: string): string {
  const p = envelopePrincipal(label)
  return p.ref ?? ((p.pre + p.post).trim() || label)
}

/** First line of a frame as a subject, and the rest as a preview.
 *
 * Mail in this system has no subject field — the sender writes a body — so the
 * subject is taken the way every mail client takes it when there is none: the
 * first line stands in for one. The markers a first line might carry (a heading
 * hash, bold, a list bullet) are stripped, because they are formatting for a
 * paragraph, not for a title. */
function splitSubject(body: string): { subject: string; preview: string } {
  const lines = body.trim().split('\n')
  let i = 0
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++
  const first = (lines[i] ?? '').trim()
  const subject = first
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\*\*(.*)\*\*$/, '$1')
    .replace(/^`(.*)`$/, '$1')
  const preview = lines
    .slice(i + 1)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return { subject, preview }
}

function EnvelopeItem({
  envelope,
  issueReferences,
  markdownHtml,
  forceFull = false,
}: {
  envelope: ParsedEnvelope
  issueReferences: IssueReferenceLookup
  markdownHtml?: ReadonlyMap<string, string> | undefined
  /** The active search hit: the matched word may be anywhere in the body, so
   *  the preview is not enough. */
  forceFull?: boolean
}): JSX.Element {
  const [opened, setOpened] = useState(false)
  const full = opened || forceFull
  const setFull = setOpened
  const { subject, preview } = useMemo(() => splitSubject(envelope.body), [envelope.body])
  const html = useMemo(() => {
    if (!full) return ''
    const unsafeHtml = markdownHtml?.get(envelope.body)
    return unsafeHtml === undefined
      ? renderMarkdown(envelope.body, issueReferences)
      : sanitizeRenderedMarkdown(unsafeHtml, issueReferences)
  }, [full, envelope.body, issueReferences, markdownHtml])
  return (
    <div className="mail-item" data-testid="mail-item" data-full={full ? 'true' : undefined}>
      <span className="mail-item-from">
        <PrincipalLabel label={envelope.from} issueReferences={issueReferences} />
      </span>
      <span className="mail-item-main">
        <button
          data-pressable
          type="button"
          className="mail-item-head"
          aria-expanded={full}
          onClick={() => {
            setFull((v) => !v)
          }}
        >
          <span className="mail-item-subject">{subject || envelope.id}</span>
          {envelope.question && <span className="mail-item-badge">question</span>}
        </button>
        {full ? (
          <div
            className="chat-md mail-item-body"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify in renderMarkdown
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          preview !== '' && <span className="mail-item-preview">{preview}</span>
        )}
        {full && envelope.machineNote && (
          <span className="mail-item-note">{envelope.machineNote}</span>
        )}
        {envelope.expectsReply && <span className="mail-item-reply">reply · {envelope.id}</span>}
      </span>
    </div>
  )
}

export function MessageEnvelopeGroup({
  envelopes,
  className,
  blockIndex,
  issueReferences,
  markdownHtml,
  ts,
  onBodyClick,
  forceOpen = false,
}: {
  envelopes: readonly ParsedEnvelope[]
  className: string
  blockIndex?: number | undefined
  issueReferences: IssueReferenceLookup
  markdownHtml?: ReadonlyMap<string, string> | undefined
  ts?: string | undefined
  /** Delegated chat-md click handling (code copy, ref chips, file links). */
  onBodyClick: (e: ReactMouseEvent) => void
  /** THE SEARCH HIT MUST BE VISIBLE. Search matches a block on its full text,
   *  including the body of a frame this group has folded away — so a hit inside
   *  mail would scroll the reader to a two-line preview that does not contain
   *  the word they searched for. The active hit unfolds the whole group and
   *  every frame in it, the same way a run of tool calls unfolds. */
  forceOpen?: boolean
}): JSX.Element {
  const consequential = envelopes.some((e) => e.question || e.expectsReply)
  // A burst GROWS. The first frame of a provider turn can be background noise —
  // the group mounts folded — and the second, arriving on the next poll into the
  // same block, can be the one asking the operator to answer something. Reading
  // `consequential` once at mount would leave that frame hidden behind a fold
  // line, which is precisely the case the fold is not for. Adjusted during
  // render rather than in an effect: no frame of the wrong state, and a manual
  // fold afterwards still sticks.
  const [fold, setFold] = useState({ opened: consequential, open: consequential })
  if (consequential && !fold.opened) setFold({ opened: true, open: true })
  const open = fold.open || forceOpen
  const setOpen = (next: boolean | ((v: boolean) => boolean)): void => {
    setFold((f) => ({ opened: true, open: typeof next === 'function' ? next(f.open) : next }))
  }
  const single = envelopes.length === 1
  const first = envelopes[0]
  const tags = useMemo(() => {
    const seen: string[] = []
    for (const e of envelopes) {
      const tag = senderTag(e.from)
      if (tag && !seen.includes(tag)) seen.push(tag)
    }
    return seen
  }, [envelopes])
  const stamp = parseTs(ts)
  // The route only names a sender when the whole burst shares one; otherwise the
  // senders are the card's left column and repeating one of them in the header
  // would be a lie about the other two.
  const sharedFrom = envelopes.every((e) => e.from === first?.from) ? first?.from : undefined

  return (
    <div
      className={className}
      data-block={blockIndex}
      data-internal-message="true"
      data-testid="message-envelope"
    >
      <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
      <div className="transcript-body">
        <div className="mail-group" data-open={open ? 'true' : 'false'}>
          <button
            data-pressable
            type="button"
            className="mail-fold"
            data-testid="message-envelope-toggle"
            aria-expanded={open}
            aria-label={open ? 'Fold these notes' : 'Unfold these notes'}
            onClick={() => {
              setOpen((v) => !v)
            }}
          >
            <MailIcon className="mail-fold-icon" size={13} aria-hidden="true" />
            <span className="mail-fold-count">
              {envelopes.length} {envelopes.length === 1 ? 'note' : 'notes'} from Podium
            </span>
            <span className="mail-fold-tags">{tags.join(' · ')}</span>
            <span className="mail-fold-gap" />
            {single && first && (
              <span className="mail-fold-meta">
                {stamp && (
                  <time dateTime={ts} title={fullTimeLabel(stamp)}>
                    {clockLabel(stamp)}
                  </time>
                )}
                {stamp && ' · '}
                {first.id}
              </span>
            )}
            <ChevronDown className="mail-fold-chev" size={14} aria-hidden="true" />
          </button>
          {open && (
            // biome-ignore lint/a11y/noStaticElementInteractions: delegated clicks activate only semantic links — the sender chips in the route and the left column, and the anchors sanitized markdown emits
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users activate those anchors natively
            <div className="mail-card" onClick={onBodyClick}>
              <div className="mail-card-head">
                <span className="mail-card-kind">From Podium</span>
                <span className="mail-card-route">
                  {sharedFrom !== undefined && (
                    <>
                      <PrincipalLabel label={sharedFrom} issueReferences={issueReferences} />
                      <span className="mail-card-arrow">→</span>
                    </>
                  )}
                  {first && <PrincipalLabel label={first.to} issueReferences={issueReferences} />}
                </span>
                <button
                  data-pressable
                  type="button"
                  className="mail-card-close"
                  aria-label="Fold these notes"
                  onClick={() => {
                    setOpen(false)
                  }}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
              <div className="mail-card-list">
                {envelopes.map((envelope) => (
                  <EnvelopeItem
                    key={envelope.id}
                    envelope={envelope}
                    issueReferences={issueReferences}
                    markdownHtml={markdownHtml}
                    forceFull={forceOpen}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
