import type { SessionView } from '@podium/client-core/session-values'
import { postureNotices, sessionModeHelp, sessionModeReadout } from '@podium/client-core/values'
import { ShieldAlert, ShieldCheck } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import type { JSX } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * THE MODE THIS SESSION IS IN (POD-6858 Task 11, harness-session-posture.md
 * §4.9): the mode the agent itself reports when it reports one, otherwise the
 * mode Podium asked for at launch. A requested mode wears the dotted rule the
 * model chip uses for a value not yet seen from the agent. Read-only: a
 * mid-session change goes through the harness, not this chip.
 */
export const SessionModeChip = observer(function SessionModeChip({
  session,
}: {
  session: Pick<SessionView, 'agentKind' | 'observedMode' | 'launchPosture'> | undefined
}): JSX.Element | null {
  const readout = session ? sessionModeReadout(session) : undefined
  if (!session || !readout) return null
  const why = sessionModeHelp(session.agentKind, readout)
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            // A button so the explanation can be reached by keyboard; it has no press.
            <button
              data-pressable
              type="button"
              className="model-token inline-flex h-7 min-w-0 max-w-full cursor-default items-center gap-1 rounded-[7px] px-2 text-[12px] leading-none text-text-faint focus-visible:outline-2 focus-visible:outline-ring"
              data-testid="session-mode"
              data-provenance={readout.source}
              aria-label={`Permissions: ${readout.mode}. ${why}`}
            />
          }
        >
          <ShieldCheck size={12} aria-hidden="true" className="flex-none" />
          <span className="model-token-text min-w-0 truncate">{readout.mode}</span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[18rem] text-left">
          {why}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
})

/**
 * WHAT THIS SESSION'S LAUNCH COULD NOT MEET (POD-6858 Task 11, §5): one line
 * per requirement the agent cannot meet here, naming it and the reason, in
 * the composer's notice area. Nothing when every requirement was met.
 */
export const PostureNotices = observer(function PostureNotices({
  session,
}: {
  session: Pick<SessionView, 'agentKind' | 'launchPosture'>
}): JSX.Element | null {
  const notices = postureNotices(session)
  if (notices.length === 0) return null
  return (
    <div className="composer-notices" data-testid="posture-notices">
      {notices.map((notice) => (
        <div
          key={notice}
          className="composer-notice composer-notice--posture"
          data-notice="posture"
        >
          <ShieldAlert size={12} aria-hidden="true" className="flex-none" />
          <span>{notice}</span>
        </div>
      ))}
    </div>
  )
})
