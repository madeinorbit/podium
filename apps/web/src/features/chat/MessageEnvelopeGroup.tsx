/**
 * PODIUM'S OWN MAIL, FOLDED TO ONE LINE (POD-993).
 *
 * System mail is provenance: a reader scanning a conversation needs to see THAT
 * one arrived and from whom, not the paragraph. Each frame used to be its own
 * row with its own header, so a turn receiving three notes spent three rows
 * before the answer got a word in.
 *
 * The whole burst is now ONE object — a counted, tinted line that opens into a
 * real mail list. See `.mail-group` in styles.css for the shape and its reasons.
 *
 * WHAT OPENS ON ARRIVAL: any frame that asks a question or requests a reply,
 * because folding it would hide the one kind of mail with a consequence.
 * WHAT IS NOT LOST: the two-line preview is a preview — clicking an item opens
 * that frame's full markdown, refs and code live.
 */
import { envelopePrincipal, type ParsedEnvelope } from '@podium/client-core/viewmodels'
import { ChevronDown, Mail as MailIcon, X } from 'lucide-react'
import type { JSX, MouseEvent as ReactMouseEvent } from 'react'
import { useMemo, useState } from 'react'
import { isKnownRefPrefix, renderMarkdown, sanitizeRenderedMarkdown } from '@/lib/markdown'
import { clockLabel, fullTimeLabel, parseTs } from './transcript-time'

/** An envelope-header principal: the nice-id issue ref renders as the same
 *  clickable ref-link chip the markdown pass emits, so the sender/recipient are
 *  as navigable as refs in the body. Legacy `#seq` labels and sessions stay
 *  plain text. */
function PrincipalLabel({ label }: { label: string }): JSX.Element {
  const p = envelopePrincipal(label)
  const chip = p.ref !== null && isKnownRefPrefix(p.ref.split('-')[0] ?? '')
  return (
    <>
      {p.pre}
      {p.ref !== null &&
        (chip ? (
          <a className="ref-link ref-link--issue" href={`#${p.ref}`} data-ref={p.ref}>
            {p.ref}
          </a>
        ) : (
          p.ref
        ))}
      {p.post}
    </>
  )
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
  markdownHtml,
  forceFull = false,
}: {
  envelope: ParsedEnvelope
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
      ? renderMarkdown(envelope.body)
      : sanitizeRenderedMarkdown(unsafeHtml)
    // Ref chips are state-free transcript content (see ChatBlockView).
  }, [full, envelope.body, markdownHtml])
  return (
    <div className="mail-item" data-testid="mail-item" data-full={full ? 'true' : undefined}>
      <span className="mail-item-from">
        <PrincipalLabel label={envelope.from} />
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
  markdownHtml,
  ts,
  onBodyClick,
  forceOpen = false,
}: {
  envelopes: readonly ParsedEnvelope[]
  className: string
  blockIndex?: number | undefined
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
  const toggle = (): void => setFold((f) => ({ opened: true, open: !f.open }))
  const single = envelopes.length === 1
  const first = envelopes[0]
  const tags = useMemo(() => {
    const seen: string[] = []
    for (const e of envelopes) {
      const p = envelopePrincipal(e.from)
      const tag = p.ref ?? ((p.pre + p.post).trim() || e.from)
      if (!seen.includes(tag)) seen.push(tag)
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
            onClick={toggle}
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
                      <PrincipalLabel label={sharedFrom} />
                      <span className="mail-card-arrow">→</span>
                    </>
                  )}
                  {first && <PrincipalLabel label={first.to} />}
                </span>
                <button
                  data-pressable
                  type="button"
                  className="mail-card-close"
                  aria-label="Fold these notes"
                  onClick={toggle}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
              <div className="mail-card-list">
                {envelopes.map((envelope) => (
                  <EnvelopeItem
                    key={envelope.id}
                    envelope={envelope}
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
