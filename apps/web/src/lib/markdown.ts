import { anyRefMatcher, parseAnyRef } from '@podium/protocol'
import DOMPurify from 'dompurify'
import { renderMarkdownUnsafe } from './markdown-renderer'

// External links in a transcript should open in a new tab — clicking one must
// never navigate away from Podium. file-link anchors (internal file opens) carry
// data-path and no href, so keying on href leaves them in-window. Runs on the
// already-sanitized HTML, so any dangerous href scheme has been stripped first;
// this only appends target/rel and never introduces markup.
export function externalizeLinks(html: string): string {
  return html.replace(/<a\b([^>]*)>/g, (full, attrs: string) => {
    if (!/\bhref=/.test(attrs)) return full // internal file-link (no href)
    if (/\bclass="[^"]*\bref-link\b/.test(attrs)) return full // internal ref activation
    if (/\btarget=/.test(attrs)) return full // already targeted
    return `<a${attrs} target="_blank" rel="noopener noreferrer">`
  })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// A token looks like a file path if it has a directory separator or a known
// code-file extension. Conservative on purpose — the backtick is the intent
// signal; this only filters out non-file code spans (commands, identifiers).
const PATHISH =
  /^[\w./@~-]+\/[\w./@~-]+$|^[\w.-]+\.(ts|tsx|js|jsx|mjs|cjs|json|md|py|css|scss|html|htm|rs|go|sh|yml|yaml|toml)$/

export function linkifyCodePaths(html: string): string {
  return html.replace(/<code>([^<]+)<\/code>/g, (full, inner: string) => {
    const token = inner.trim()
    if (!PATHISH.test(token)) return full
    return `<code><a class="file-link" data-path="${token}">${inner}</a></code>`
  })
}

// The set of registered repo prefixes (#474). Only tokens whose prefix matches
// one of these are linkified — this is what keeps `UTF-8` and other real hyphens
// from turning into dead ref links. The app updates it whenever the repo list
// loads; empty (the default) disables ref linkification entirely.
let knownRefPrefixes = new Set<string>()

/** Update the registered repo prefixes the ref linkifier recognises (#474). */
export function setKnownRefPrefixes(prefixes: Iterable<string>): void {
  knownRefPrefixes = new Set(prefixes)
}

/** The registered repo prefixes (#474). Shared with the terminal link provider so
 *  markdown and terminal linkify agree on which tokens are real refs. */
export function getKnownRefPrefixes(): ReadonlySet<string> {
  return knownRefPrefixes
}

/** Whether `prefix` is a registered repo prefix (#474). */
export function isKnownRefPrefix(prefix: string): boolean {
  return knownRefPrefixes.has(prefix)
}

/**
 * Turn `PREFIX-N` / `PREFIX-N-LETTER` / `PREFIX-DRAFT-N` tokens into ref anchors
 * (#474), analogous to {@link linkifyCodePaths}. Runs on sanitized HTML and only
 * rewrites TEXT nodes — never inside an existing `<a>`, never inside a fenced
 * block, and never a tag's own attributes — so it can't double-link or corrupt
 * markup. Only tokens whose prefix is a registered repo prefix become links.
 *
 * An inline code span whose WHOLE content is a single ref is unwrapped into the
 * chip: `POD-13` in backticks is how the ref is written everywhere — the agent
 * instructions spell it that way — so treating the backticks as "leave this
 * literal" cost most refs in chat their stage colour and their popup. A ref
 * quoted inside a longer span (a command line, a path) stays literal: there the
 * backticks really are quoting text. Fenced blocks are never touched.
 *
 * Emits a real in-page anchor so keyboard activation and WebView hit testing use
 * native link behavior. The delegated click handler prevents the hash fallback
 * and reads data-ref; externalizeLinks keeps these in-window. The kind modifier
 * picks the chip icon (issue vs session).
 */
/** The chip anchor for one already-validated ref token, or null if the token is
 *  not a ref of a registered prefix. */
function refAnchor(tok: string): string | null {
  const ref = parseAnyRef(tok)
  if (!ref || !knownRefPrefixes.has(ref.prefix)) return null
  // NO LIVE STATE IN THE STRING (POD-1290 follow-up). Stage, availability and
  // the accessible label used to be baked in here — which made every row's
  // html a function of the issue store, so each of the fleet's deltas
  // rewrote referenced rows' innerHTML, destroying their subtrees: the
  // reader's text selection died on a 2-5s clock and the layout shifted
  // under the scroller. The alpha keeps the chip deliberately state-free;
  // liveness is not transcript content and may not rewrite this string.
  return `<a class="ref-link ref-link--${ref.kind}" href="#${tok}" data-ref="${tok}">${tok}</a>`
}

/** Whether the text is exactly one ref token and nothing else. */
function soleRefToken(text: string): string | null {
  const tok = text.trim()
  if (!tok) return null
  const m = anyRefMatcher().exec(tok)
  return m && m[0] === tok ? tok : null
}

export function linkifyRefs(html: string): string {
  if (knownRefPrefixes.size === 0) return html
  const parts = html.split(/(<[^>]+>)/)
  let inAnchor = 0
  let inCode = 0
  let inPre = 0
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!
    if (p.startsWith('<')) {
      if (/^<a\b/i.test(p)) inAnchor++
      else if (/^<\/a>/i.test(p)) inAnchor = Math.max(0, inAnchor - 1)
      else if (/^<pre\b/i.test(p)) inPre++
      else if (/^<\/pre>/i.test(p)) inPre = Math.max(0, inPre - 1)
      else if (/^<code\b/i.test(p)) {
        inCode++
        // `<code>` + text + `</code>` where the text is nothing but a ref: drop
        // the code wrapper and let the chip stand on its own, rather than
        // nesting chip chrome inside mono chrome.
        const tok = inPre === 0 && inAnchor === 0 ? soleRefToken(parts[i + 1] ?? '') : null
        const anchor = tok && /^<\/code>/i.test(parts[i + 2] ?? '') ? refAnchor(tok) : null
        if (anchor) {
          parts[i] = ''
          parts[i + 1] = anchor
          parts[i + 2] = ''
          inCode--
          i += 2
        }
      } else if (/^<\/code>/i.test(p)) inCode = Math.max(0, inCode - 1)
      continue
    }
    if (inAnchor > 0 || inCode > 0 || inPre > 0 || p === '') continue
    parts[i] = p.replace(anyRefMatcher(), (tok) => refAnchor(tok) ?? tok)
  }
  return parts.join('')
}

/** Markdown → sanitized HTML. The single render path for all chat surfaces. */
/**
 * Finish an unsafe worker result on the browser thread. This is the only
 * function allowed to cross from transcript compute into the DOM render path:
 * path/ref linkification and DOMPurify remain main-thread policy decisions.
 */
export function sanitizeRenderedMarkdown(unsafeHtml: string): string {
  const rendered = linkifyCodePaths(unsafeHtml)
  return externalizeLinks(linkifyRefs(DOMPurify.sanitize(rendered)))
}

export function renderMarkdown(text: string): string {
  return sanitizeRenderedMarkdown(renderMarkdownUnsafe(text))
}

/**
 * Markdown → sanitized HTML for a READOUT, not a document (POD-1455).
 *
 * A task's description is written the way everything else in this product is
 * written — a lead-in line, a blank line, a list of things to do — and until now
 * every surface printed that as one run of text with the hyphens still in it.
 * The structure is the meaning, so it gets rendered.
 *
 * WHAT IT DOES NOT RENDER IS THE POINT. `renderMarkdown` is the transcript's
 * path: ref chips, file links and external anchors, each of which only works
 * because the chat surface installs a click handler for it. A brief in the
 * flight deck's header sits INSIDE the mission's own click target, so an anchor
 * there is either dead or a second thing to hit by accident. Anchors and images
 * are dropped and their text kept, which leaves exactly the structure — breaks,
 * paragraphs, lists, emphasis, inline code — and nothing to click.
 */
export function renderReadoutMarkdown(text: string): string {
  return DOMPurify.sanitize(renderMarkdownUnsafe(text), {
    FORBID_TAGS: ['a', 'img', 'button', 'iframe'],
  })
}
