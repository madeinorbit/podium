import { useCommands, useUi } from '@podium/client-core/react'
import type { SessionModel } from '@podium/client-graph'
import type { MachineHarness } from '@podium/client-graph/machine-harness'
import type { BuiltinHarnessKind, IssueId, SessionId } from '@podium/model'
import { observer } from 'mobx-react-lite'
import { useWorklistPool } from '@/app/store-worklist-pool'
import type { Trpc } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import { openSetupAgents } from '@/features/setup-agents/open-setup-agents'

/**
 * A start that failed on the person's too-old install: open Set up agents on
 * that harness. Nothing installs until the person presses Install there; its
 * "Start <harness> session" hands back here and starts the same launch again
 * (on the person's default credential for the harness, else its own sign-in).
 */
export const InstallCurrentHarness = observer(function InstallCurrentHarness({
  sessionId,
  firstPrompt,
}: {
  sessionId: SessionId
  firstPrompt?: string
}) {
  const pool = useWorklistPool()
  const session = pool?.sessionObject(sessionId)
  const row = session?.installRecoveryHarness
  return row && session ? (
    <InstallCurrentHarnessControl session={session} row={row} firstPrompt={firstPrompt} />
  ) : null
})

const InstallCurrentHarnessControl = observer(function InstallCurrentHarnessControl({
  session,
  row,
  firstPrompt,
}: {
  session: SessionModel
  row: MachineHarness
  firstPrompt?: string
}) {
  const commands = useCommands<Trpc>()
  const ui = useUi()
  const restart = (harness: BuiltinHarnessKind) => {
    if (!session.cwd) return
    // The person may set up and start another harness from the panel; the failed
    // launch's model and effort belong to the harness it named.
    const same = harness === row.kind
    const input = session.launch?.input as
      | { issueId?: IssueId; model?: string; effort?: string }
      | undefined
    const started = commands.sessions.launch({
      target: { path: session.cwd, repoPath: session.cwd, machineId: row.machine.id },
      agentKind: harness,
      ...(input?.issueId ? { issueId: input.issueId } : {}),
      ...(firstPrompt ? { firstPrompt } : {}),
      ...(same && input?.model ? { model: input.model } : {}),
      ...(same && input?.effort ? { effort: input.effort } : {}),
    })
    void commands.sessions.killSession(session.sessionId)
    ui.navigateToSession(started.sessionId)
  }
  return (
    <Button
      size="xs"
      variant="outline"
      onClick={() =>
        openSetupAgents({
          machineId: row.machine.id,
          origin: 'menu',
          focus: row.kind,
          onStart: restart,
        })
      }
    >
      {row.managed?.active ? `Start on Podium’s ${row.label}…` : `Set up a current ${row.label}…`}
    </Button>
  )
})
