/**
 * Split an offer's prose into text and link runs so every surface can render
 * the URLs an agent writes as real links [SP-c7f1].
 *
 * WHY A SEGMENTER AND NOT MARKDOWN. The offer body is one short paragraph in a
 * compact bar; running it through the transcript's marked+DOMPurify pipeline
 * would buy headings, tables and fenced code for a card that has room for none
 * of them, and would hand the phone — which renders into React Native `Text`,
 * not HTML — a string it cannot use. Segments are the smallest thing both
 * renderers can consume, and they carry no markup, so neither host has to
 * sanitize.
 *
 * ONLY http(s). A `javascript:` or `data:` href is never produced, so no caller
 * needs a scheme allowlist of its own.
 */

/** One run of an offer message: literal prose, or a link to open externally. */
export type OfferTextSegment =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; href: string }

/** `[label](https://…)` first, so a markdown link is never also matched as a
 *  bare URL; then a bare http(s) run. */
const OFFER_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"'`]+)/g

/** Sentence punctuation that follows a bare URL far more often than it belongs
 *  to one. A closing bracket is only trailing when it is unbalanced, so
 *  `https://en.wikipedia.org/wiki/Foo_(bar)` keeps its tail. */
function trimTrailingPunctuation(url: string): string {
  let end = url.length
  while (end > 0) {
    const ch = url[end - 1] as string
    if (ch === ')' || ch === ']' || ch === '}') {
      const open = ch === ')' ? '(' : ch === ']' ? '[' : '{'
      const slice = url.slice(0, end)
      let depth = 0
      for (const c of slice) {
        if (c === open) depth++
        else if (c === ch) depth--
      }
      if (depth >= 0) break
      end--
      continue
    }
    if ('.,;:!?"\''.includes(ch)) {
      end--
      continue
    }
    break
  }
  return url.slice(0, end)
}

/**
 * Segment `message` into prose and links, in order. Always returns at least one
 * segment for a non-empty message; an empty message returns an empty array.
 */
export function segmentOfferText(message: string): OfferTextSegment[] {
  const segments: OfferTextSegment[] = []
  let cursor = 0
  const push = (text: string): void => {
    if (!text) return
    const last = segments[segments.length - 1]
    if (last?.kind === 'text') last.text += text
    else segments.push({ kind: 'text', text })
  }

  OFFER_LINK.lastIndex = 0
  let match = OFFER_LINK.exec(message)
  while (match !== null) {
    const [whole, label, labelled, bare] = match
    push(message.slice(cursor, match.index))
    if (labelled !== undefined && label !== undefined) {
      segments.push({ kind: 'link', text: label, href: labelled })
    } else if (bare !== undefined) {
      const href = trimTrailingPunctuation(bare)
      // A run that is nothing but a scheme (`https://.`) is punctuation, not a
      // link; it goes back into the prose whole.
      if (href.length > bare.indexOf('//') + 2) {
        segments.push({ kind: 'link', text: href, href })
        push(bare.slice(href.length))
      } else {
        push(bare)
      }
    }
    cursor = match.index + whole.length
    match = OFFER_LINK.exec(message)
  }
  push(message.slice(cursor))
  return segments
}

/** Whether `message` contains anything the renderers would turn into a link. */
export function hasOfferLink(message: string): boolean {
  return segmentOfferText(message).some((segment) => segment.kind === 'link')
}
