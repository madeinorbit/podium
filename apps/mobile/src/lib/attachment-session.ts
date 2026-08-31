import type { SessionId } from '@podium/model'

/** Resolve an upload target only when accepted bytes need one. Concurrent first
 * attachments share the same creation promise, so one empty Superagent thread
 * cannot mint two headless sessions. */
export function createAttachmentSessionResolver(
  readCurrent: () => SessionId | undefined,
  ensure?: () => Promise<SessionId>,
): () => Promise<SessionId> {
  let creating: Promise<SessionId> | null = null
  let prepared: SessionId | undefined
  return async () => {
    const current = readCurrent()
    if (current) return current
    // A parent render normally publishes the newly created id immediately, but
    // an overlapping picker batch can reach this resolver before that render.
    // Keep the result for this composer's lifetime so the queue cannot mint a
    // second headless session after the first creation promise settles.
    if (prepared) return prepared
    if (!ensure) throw new Error('No session is available for this attachment.')
    if (!creating) {
      creating = ensure()
        .then((sessionId) => {
          prepared = sessionId
          return sessionId
        })
        .finally(() => {
          creating = null
        })
    }
    return creating
  }
}

/** Empty picker results stop here; accepted attachments resolve one target and
 * then upload in series to avoid duplicating payload memory. */
export async function uploadWithResolvedSession<T>(
  items: readonly T[],
  resolveSession: () => Promise<SessionId>,
  upload: (item: T, sessionId: SessionId) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return
  const sessionId = await resolveSession()
  for (const item of items) await upload(item, sessionId)
}
