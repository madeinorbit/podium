/**
 * Word-level HTML diff (#172) — renders a spec component's branch change as ONE
 * merged document with <ins>/<del> marks, instead of a raw text patch.
 *
 * Approach (classic htmldiff): tokenize both HTML strings into tags,
 * whitespace runs, and words; LCS over the token streams; wrap inserted /
 * deleted runs in <ins>/<del>. Tags are atomic tokens and are never wrapped
 * themselves when unchanged; changed regions keep their tags inside the mark
 * so structure (lists, bold) survives.
 *
 * Inputs are trusted spec bodies (already stored/rendered elsewhere); this
 * does not sanitize.
 */

function tokenize(html: string): string[] {
  return html.match(/<[^>]+>|\s+|[^<\s]+/g) ?? []
}

/** LCS table over token arrays (fine for spec-sized documents). */
function lcsOps(a: string[], b: string[]): ('same' | 'del' | 'ins')[] {
  const n = a.length
  const m = b.length
  // dp[i][j] = LCS length of a[i:], b[j:]
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const ops: ('same' | 'del' | 'ins')[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push('same')
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push('del')
      i++
    } else {
      ops.push('ins')
      j++
    }
  }
  while (i < n) {
    ops.push('del')
    i++
  }
  while (j < m) {
    ops.push('ins')
    j++
  }
  return ops
}

const isTag = (t: string): boolean => t.startsWith('<')
const isVoidOrClosing = (t: string): boolean => /^<\/|^<(br|hr|img)\b/.test(t)

/**
 * Merge `base` and `head` HTML into one document where removed content is
 * wrapped in <del> and added content in <ins>. Null/empty sides degrade to a
 * whole-document mark.
 */
export function diffHtml(base: string | null, head: string | null): string {
  const a = tokenize(base ?? '')
  const b = tokenize(head ?? '')
  if (a.length === 0) return b.length ? `<ins>${head}</ins>` : ''
  if (b.length === 0) return `<del>${base}</del>`
  const ops = lcsOps(a, b)
  const out: string[] = []
  let i = 0
  let j = 0
  let k = 0
  const flushRun = (kind: 'del' | 'ins'): void => {
    const run: string[] = []
    while (k < ops.length && ops[k] === kind) {
      run.push(kind === 'del' ? a[i++]! : b[j++]!)
      k++
    }
    // A run that is ONLY structural tags/whitespace (e.g. a rewrapped <p>)
    // renders as noise inside a mark — emit it unmarked instead.
    const hasText = run.some((t) => !isTag(t) && t.trim() !== '')
    const body = run.join('')
    if (!hasText) {
      out.push(body)
      return
    }
    // Don't let a mark open right before a closing tag — hoist leading
    // closers out so <ins>/<del> stays inside the element it annotates.
    let lead = 0
    while (lead < run.length && isTag(run[lead]!) && isVoidOrClosing(run[lead]!)) lead++
    out.push(run.slice(0, lead).join(''))
    out.push(`<${kind}>${run.slice(lead).join('')}</${kind}>`)
  }
  while (k < ops.length) {
    const op = ops[k]!
    if (op === 'same') {
      out.push(a[i]!)
      i++
      j++
      k++
    } else {
      flushRun(op)
    }
  }
  return out.join('')
}
