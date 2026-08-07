/**
 * Authority send replies that resolve HTTP 200 with `{ ok: false, … }`.
 *
 * Mirrored from `@podium/client-core` `assertSendAccepted` so the web UI can
 * depend on it without requiring a rebuilt workspace link (worktrees share
 * main's node_modules/@podium). Keep in lockstep with packages/client-core.
 *
 * Call after every `sessions.sendText` / `resumeAndSend` mutate so a dead-letter
 * or refused send surfaces as a thrown error the offer bar can retry (POD-552).
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
