import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { serverConfig } from '@/app/trpc'
import { authRequest } from '@/features/setup/member-api'

const NONE: readonly string[] = []

interface ViewerRead {
  status: 'loading' | 'ready' | 'error'
  sections: readonly string[]
}

export interface AdminViewer extends ViewerRead {
  retry: () => void
}

/** Sections within Settings share the opening's capability answer. */
export const AdminViewerContext = createContext<AdminViewer | null>(null)

/**
 * WHICH ADMIN SECTIONS THIS VIEWER MAY OPEN (POD-6299), as the server answers
 * `/auth/admin/viewer`: every section for an admin, none for a member.
 *
 * A rendering hint with no authority: each admin endpoint refuses a member
 * itself. Pending and failed reads offer no sections, but remain distinct
 * from a member's settled answer so deep links can wait and failures can retry.
 *
 * Plain component state rather than a pool request answer: the command
 * palette asks this at startup, and the startup bundle carries no optional
 * client-graph screen code (scripts/web-bundle-budget.ts).
 */
export function useAdminSections(): AdminViewer {
  const provided = useContext(AdminViewerContext)
  const [read, setRead] = useState<ViewerRead>({ status: 'loading', sections: NONE })
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => {
    setRead({ status: 'loading', sections: NONE })
    setAttempt((value) => value + 1)
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt restarts the read after Retry.
  useEffect(() => {
    if (provided) return
    let current = true
    const origin = serverConfig(window.location).httpOrigin
    authRequest<{ sections?: readonly string[] }>(origin, 'admin/viewer')
      .then((answer) => {
        if (current)
          setRead({
            status: 'ready',
            sections: Array.isArray(answer.sections) ? answer.sections : NONE,
          })
      })
      .catch(() => {
        if (current) setRead({ status: 'error', sections: NONE })
      })
    return () => {
      current = false
    }
  }, [provided, attempt])
  return provided ?? { ...read, retry }
}
