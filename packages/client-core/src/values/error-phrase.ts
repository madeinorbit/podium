/**
 * WHAT WE CALL AN ERROR CLASS — the app's lexicon for a stopped agent
 * (POD-1601).
 *
 * Its own module because it answers its own question. `session-status` asks
 * "what is this one session doing"; this asks "what are the words for this
 * failure", takes no session, and is read by surfaces at three different scopes
 * — the session badge, the worklist row, the task-level rollups in `mission`.
 * Putting it there would have been the second exception to F1's size clause,
 * which that clause says to read as one question becoming two.
 *
 * THE TABLE IS AN ALLOWLIST, AND THAT IS THE POINT. `error.class` holds whatever
 * the harness put in it: Claude Code forwards its `StopFailure` hook's raw
 * `error_type`/`matcher`, Cursor sends the literal `error` or `failed`, Grok has
 * its own vocabulary, and any provider may add a spelling tomorrow.
 * Interpolating the token printed `error: max_output_tokens` — a log line
 * wearing a row's clothes. A class with no phrase written for it is a class we
 * cannot describe, and `Agent errored` is the honest form of exactly that.
 */
const ERROR_PHRASE: Record<string, string> = {
  overloaded: 'Agent overloaded',
  rate_limit: 'Rate limited',
  usage_limit: 'Usage limit reached',
  max_output_tokens: 'Hit the output limit',
  server_error: 'Provider error',
  network_error: 'Network error',
  authentication: 'Sign-in failed',
  billing_error: 'Billing problem',
}

/**
 * The words for one error class, in the caller's grammar.
 *
 * Two registers because the app has two: session badges and worklist status
 * lines are lower case (`needs answer`, `ready to merge`), while the explorer's
 * state column, the sub-issue list and mobile's TaskSheet are sentence case
 * (`Needs you`, `Standing by`).
 *
 * KEEP EVERY PHRASE FREE OF ACRONYMS AND PROPER NOUNS — `lower` only touches the
 * first letter, so `API error` would come back as `aPI error`. `Provider error`
 * is in the table instead for exactly that reason.
 */
export function errorPhrase(cls: string | undefined, grammar: 'sentence' | 'lower'): string {
  const phrase = (cls ? ERROR_PHRASE[cls] : undefined) ?? 'Agent errored'
  return grammar === 'sentence' ? phrase : phrase.charAt(0).toLowerCase() + phrase.slice(1)
}
