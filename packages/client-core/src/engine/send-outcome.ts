/**
 * Authority send replies that resolve HTTP 200 with `{ ok: false, … }`.
 *
 * The substrate deliberately returns a result rather than throwing for
 * unaddressable / refused chat (POD-379). The client outbox used to treat any
 * non-throwing mutate as `applied`, so a dead-lettered first prompt was
 * permanently "done" while the agent never saw it (POD-546). Offer-button and
 * chat callers that ignored `ok:false` dismissed the UI while the agent never
 * saw the prompt (POD-552).
 *
 * Call this after every `sessions.resumeAndSend` / `sessions.sendText` mutate
 * that runs through the outbox (or a best-effort first-prompt path) so `ok:
 * false` becomes a definitive BAD_REQUEST refusal and parks in dead-letter
 * recovery instead of vanishing. Live chat/offer callers use the same helper so
 * the UI can surface and retry.
 */

export function assertSendAccepted(result: unknown): void {
  if (
    result === null ||
    typeof result !== 'object' ||
    !('ok' in result) ||
    (result as { ok: unknown }).ok !== false
  ) {
    return
  }
  const reason =
    'reason' in result && typeof (result as { reason: unknown }).reason === 'string'
      ? (result as { reason: string }).reason
      : 'send refused'
  throw Object.assign(new Error(reason), { data: { code: 'BAD_REQUEST' as const } })
}
