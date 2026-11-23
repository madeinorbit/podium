import { useCommands, useUi } from '@podium/client-core/react'
import type { SessionModel } from '@podium/client-graph'
import type { MachineHarness } from '@podium/client-graph/machine-harness'
import type { BuiltinHarnessKind, IssueId, SessionId } from '@podium/model'
import { observer } from 'mobx-react-lite'
import { useState } from 'react'
import { Text, View } from 'react-native'
import { useMobilePool } from '../client/mobile-pool'
import type { MobileTrpc } from '../client/trpc'
import { color, font, sans, space } from '../theme/theme'
import { PhoneAgentSetupSheet } from './AgentSetupSheet'
import { PressableScale } from './PressableScale'

export const PhoneInstallCurrentHarness = observer(function PhoneInstallCurrentHarness({
  sessionId,
}: {
  sessionId: SessionId
}) {
  const pool = useMobilePool()
  const session = pool?.sessionObject(sessionId)
  const row = session?.installRecoveryHarness
  return pool && session && row ? <Recovery session={session} row={row} /> : null
})

const Recovery = observer(function Recovery({
  session,
  row,
}: {
  session: SessionModel
  row: MachineHarness
}) {
  const [open, setOpen] = useState(false)
  const commands = useCommands<MobileTrpc>()
  const ui = useUi()
  const start = (harness: BuiltinHarnessKind) => {
    if (!session.cwd) return
    const input = session.launch?.input as
      | { issueId?: IssueId; model?: string; effort?: string; firstPrompt?: string }
      | undefined
    const launched = commands.sessions.launch({
      target: { path: session.cwd, repoPath: session.cwd, machineId: row.machine.id },
      agentKind: harness,
      ...(session.issueId ? { issueId: session.issueId } : {}),
      ...(harness === row.kind && input?.model ? { model: input.model } : {}),
      ...(harness === row.kind && input?.effort ? { effort: input.effort } : {}),
      ...(input?.firstPrompt ? { firstPrompt: input.firstPrompt } : {}),
    })
    void commands.sessions.killSession(session.sessionId)
    ui.navigateToSession(launched.sessionId)
  }
  return (
    <View style={{ padding: space.sm }}>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`Set up ${row.label}`}
        onPress={() => setOpen(true)}
        style={{ minHeight: 44, justifyContent: 'center' }}
      >
        <Text style={{ ...sans(), color: color.accentTint, fontSize: font.body }}>
          Install a current version for Podium…
        </Text>
      </PressableScale>
      {open ? (
        <PhoneAgentSetupSheet
          machineId={row.machine.id}
          origin="menu"
          focus={row.kind}
          onClose={() => setOpen(false)}
          onStart={start}
        />
      ) : null}
    </View>
  )
})
