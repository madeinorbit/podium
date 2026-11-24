/**
 * Mounted once in the app shell: loads and renders the "Set up agents" dialog
 * only once something calls `openSetupAgents` (see `SetupAgentsDialog`).
 */

import { observer } from '@podium/client-graph/react'
import { lazy, Suspense, useState } from 'react'
import { throughRestarts } from '@/lib/chunk-recovery'
import { setupAgentsRequest } from './open-setup-agents'

const SetupAgentsDialog = lazy(() => throughRestarts(() => import('./SetupAgentsDialog')))

export const SetupAgentsDialogHost = observer(function SetupAgentsDialogHost() {
  const open = setupAgentsRequest() !== null
  // Once loaded, stay mounted so the dialog can animate closed.
  const [opened, setOpened] = useState(false)
  if (open && !opened) setOpened(true)
  if (!open && !opened) return null
  return (
    <Suspense fallback={null}>
      <SetupAgentsDialog />
    </Suspense>
  )
})
