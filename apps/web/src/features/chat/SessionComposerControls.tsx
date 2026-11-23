import type { SessionModel } from '@podium/client-graph/models'
import { ContextUsageIndicator } from './ContextUsageIndicator'
import { SessionModelChip } from './SessionModelChip'
import { SessionModeChip } from './SessionPosture'

/** One slot in both composer layouts. Context support is independent of the
 * model chip's picker/readout availability. */
export function SessionComposerControls({
  session,
  active = true,
}: {
  session: SessionModel | undefined
  active?: boolean
}) {
  return (
    <span className="flex min-w-0 items-center" data-testid="session-composer-controls">
      <SessionModelChip session={session} />
      <ContextUsageIndicator session={session} active={active} />
      <SessionModeChip session={session} />
    </span>
  )
}
