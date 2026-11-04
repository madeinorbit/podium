import { RequestAnswer } from '@podium/client-graph/request-answer'
import { useEffect, useMemo } from 'react'
import { serverConfig } from '@/app/trpc'
import { authRequest } from '@/features/setup/member-api'

/**
 * WHICH ADMIN SECTIONS THIS VIEWER MAY OPEN (POD-6299), as the server answers
 * `/auth/admin/viewer`: every section for an admin, none for a member.
 *
 * A rendering hint with no authority: each admin endpoint refuses a member
 * itself. Until the read answers, and when it fails, the answer is no
 * sections, so an admin tab is never drawn on an assumption.
 */
export function useAdminSections(): RequestAnswer<readonly string[]> {
  const answer = useMemo(() => new RequestAnswer<readonly string[]>(), [])
  useEffect(() => {
    const origin = serverConfig(window.location).httpOrigin
    void answer.load(
      async () =>
        (await authRequest<{ sections: readonly string[] }>(origin, 'admin/viewer')).sections,
    )
    return () => answer.close()
  }, [answer])
  return answer
}
