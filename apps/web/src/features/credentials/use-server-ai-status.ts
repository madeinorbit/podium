import { RequestAnswer } from '@podium/client-graph/request-answer'
import { followVisibleRequest } from '@podium/client-graph/visible-request'
import { useEffect, useMemo } from 'react'
import type { Trpc } from '@/app/trpc'
import { useSettingsTrpc } from '@/features/settings/stable-access'

type ServerAiStatus = Awaited<ReturnType<Trpc['credentials']['serverAiStatus']['query']>>

/** A request answer for the background role; no credential record is invented for it. */
export function useServerAiStatus(enabled: boolean): ServerAiStatus {
  const trpc = useSettingsTrpc()
  const request = useMemo(() => new RequestAnswer<ServerAiStatus>(), [])
  useEffect(() => {
    if (!enabled) return
    const stop = followVisibleRequest(
      () => {
        if (!request.loading) void request.load(() => trpc.credentials.serverAiStatus.query())
      },
      {
        visible: () => document.visibilityState !== 'hidden',
        subscribe: (changed) => {
          document.addEventListener('visibilitychange', changed)
          return () => document.removeEventListener('visibilitychange', changed)
        },
      },
    )
    return () => {
      stop()
      request.close()
    }
  }, [enabled, request, trpc])
  return enabled ? request.answer : undefined
}
