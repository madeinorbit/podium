import { useEffect, useState } from 'react'
import { serverConfig } from '@/app/trpc'
import { authRequest } from '@/features/setup/member-api'

const NONE: readonly string[] = []

/**
 * WHICH ADMIN SECTIONS THIS VIEWER MAY OPEN (POD-6299), as the server answers
 * `/auth/admin/viewer`: every section for an admin, none for a member.
 *
 * A rendering hint with no authority: each admin endpoint refuses a member
 * itself. Until the read answers, and when it fails, the answer is no
 * sections, so an admin tab is never drawn on an assumption.
 *
 * Plain component state rather than a pool request answer: the command
 * palette asks this at startup, and the startup bundle carries no optional
 * client-graph screen code (scripts/web-bundle-budget.ts).
 */
export function useAdminSections(): readonly string[] {
  const [sections, setSections] = useState<readonly string[]>(NONE)
  useEffect(() => {
    let current = true
    const origin = serverConfig(window.location).httpOrigin
    authRequest<{ sections?: readonly string[] }>(origin, 'admin/viewer')
      .then((answer) => {
        if (current) setSections(Array.isArray(answer.sections) ? answer.sections : NONE)
      })
      .catch(() => {})
    return () => {
      current = false
    }
  }, [])
  return sections
}
