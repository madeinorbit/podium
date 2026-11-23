/**
 * THE CREDENTIAL A SESSION RUNS ON, AS THE PHONE NAMES IT (credential
 * management §9 "On the session"): its label, read-only. Switching is the
 * web's. My `credentials.list` is read once per pool when a session screen
 * opens, and again after a minute, into the pool's shared credential models.
 */

import { useRequestClient } from '@podium/client-core/react'
import type { MobxPool } from '@podium/client-graph/pool'
import { RecordRequest } from '@podium/client-graph/requested-records'
import type { CredentialView } from '@podium/model'
import { useCallback, useEffect, useState } from 'react'
import { useMobilePool, useMobilePoolProjection } from './mobile-pool'
import type { MobileTrpc } from './trpc'

export const OWN_LOGIN_LABEL = 'Its own login'
export const OTHER_MEMBERS_LABEL = 'Another member’s credential'

/** The label of the credential a session runs on; undefined until the list is known. */
export function sessionCredentialLabel(
  credentialId: string | null | undefined,
  views: readonly Pick<CredentialView, 'id' | 'label'>[] | undefined,
): string | undefined {
  if (!credentialId) return OWN_LOGIN_LABEL
  if (!views) return undefined
  return views.find((view) => view.id === credentialId)?.label ?? OTHER_MEMBERS_LABEL
}

const STALE_MS = 60_000
const lists = new WeakMap<MobxPool, SharedList>()

type SharedList = { request: RecordRequest<'credential'>; readAt: number }

/** The pool's one credential request, made in an effect; none on a stand-in pool. */
function listOf(pool: MobxPool): SharedList | undefined {
  let list = lists.get(pool)
  if (!list) {
    try {
      list = {
        request: new RecordRequest(pool, 'credential', (row) => row.id as string),
        readAt: 0,
      }
    } catch {
      return undefined
    }
    lists.set(pool, list)
  }
  return list
}

export function useSessionCredentialLabel(
  credentialId: string | null | undefined,
): string | undefined {
  const pool = useMobilePool()
  const trpc = useRequestClient<MobileTrpc>()
  const [list, setList] = useState<SharedList | undefined>(undefined)
  useEffect(() => {
    if (!pool || !credentialId) return
    const shared = listOf(pool)
    setList(shared)
    if (!shared || Date.now() - shared.readAt < STALE_MS) return
    shared.readAt = Date.now()
    void shared.request.read(() => trpc.credentials.list.query())
  }, [pool, trpc, credentialId])
  const read = useCallback(
    (_pool: MobxPool) => {
      const views =
        list === undefined || list.request.answer === undefined
          ? undefined
          : (list.request.models as unknown as readonly CredentialView[])
      return sessionCredentialLabel(credentialId, views)
    },
    [credentialId, list],
  )
  return useMobilePoolProjection(read, credentialId ? undefined : OWN_LOGIN_LABEL)
}
