import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { serverConfig } from '@/app/trpc'
import { authRequest } from '@/features/setup/member-api'

const NONE: readonly string[] = []

/** What the server lets this viewer do beyond the admin sections. */
export interface ViewerCapabilities {
  /** May add a machine of their own (POD-6883). False until the server says so. */
  addMachine: boolean
  /**
   * Is the one who sets this server up (POD-6882): the workspace's first admin.
   * Undefined until the server answers. A server too old to say, or a read
   * that failed, answers true: first-run setup then behaves exactly as it did
   * before the server could tell a joined member from its installer.
   */
  setUpServer?: boolean
}
const PENDING: ViewerCapabilities = { addMachine: false }
const UNKNOWN: ViewerCapabilities = { addMachine: false, setUpServer: true }

function readCapabilities(raw: unknown): ViewerCapabilities {
  const answer = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return { addMachine: answer.addMachine === true, setUpServer: answer.setUpServer !== false }
}

interface ViewerRead {
  status: 'loading' | 'ready' | 'error'
  sections: readonly string[]
  /** Always set by this hook; optional so a provided viewer may leave it out (unknown). */
  capabilities?: ViewerCapabilities
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
  const [read, setRead] = useState<ViewerRead>({
    status: 'loading',
    sections: NONE,
    capabilities: PENDING,
  })
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => {
    setRead({ status: 'loading', sections: NONE, capabilities: PENDING })
    setAttempt((value) => value + 1)
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt restarts the read after Retry.
  useEffect(() => {
    if (provided) return
    let current = true
    const origin = serverConfig(window.location).httpOrigin
    authRequest<{ sections?: readonly string[]; capabilities?: unknown }>(origin, 'admin/viewer')
      .then((answer) => {
        if (current)
          setRead({
            status: 'ready',
            sections: Array.isArray(answer.sections) ? answer.sections : NONE,
            capabilities: readCapabilities(answer.capabilities),
          })
      })
      .catch(() => {
        if (current) setRead({ status: 'error', sections: NONE, capabilities: UNKNOWN })
      })
    return () => {
      current = false
    }
  }, [provided, attempt])
  return provided ?? { ...read, retry }
}
