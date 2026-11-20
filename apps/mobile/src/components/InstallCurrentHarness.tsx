import { useCommands, useRequestClient, useUi } from '@podium/client-core/react'
import type { SessionModel } from '@podium/client-graph'
import { HarnessInstallAnswer } from '@podium/client-graph/harness-installs-view'
import type { MachineHarness } from '@podium/client-graph/machine-harness'
import { RecordRequest } from '@podium/client-graph/requested-records'
import { sessionCredentialChoices } from '@podium/client-graph/session-credential-facts'
import { BUNDLED_DESCRIPTORS } from '@podium/harness/browser'
import type { CredentialId, CredentialView, IssueId, SessionId } from '@podium/model'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { useEffect, useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useMobilePool } from '../client/mobile-pool'
import type { MobileTrpc } from '../client/trpc'
import { color, space } from '../theme/theme'

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
  const pool = useMobilePool()
  const client = useRequestClient<MobileTrpc>()
  const commands = useCommands<MobileTrpc>()
  const ui = useUi()
  const router = useRouter()
  const answer = useMemo(() => new HarnessInstallAnswer(), [])
  const credentials = useMemo(
    () => (pool ? new RecordRequest(pool, 'credential', (record) => record.id) : undefined),
    [pool],
  )
  const [installed, setInstalled] = useState(() => !!row.managed?.active)
  useEffect(() => {
    if (installed) void credentials?.read(() => client.credentials.list.query())
  }, [installed, credentials, client])
  useEffect(
    () => () => {
      answer.close()
      credentials?.dispose()
    },
    [answer, credentials],
  )
  const choices = sessionCredentialChoices({
    views: (credentials?.models ?? []) as unknown as readonly CredentialView[],
    accepts: BUNDLED_DESCRIPTORS.find((item) => item.kind === row.kind)?.accepts ?? [],
    machineId: row.machine.id,
    custodianOf: () => row.machine.custodian,
  })
  const start = (credentialId: CredentialId) => {
    if (!session.cwd) return
    const input = session.launch?.input as
      | { issueId?: IssueId; model?: string; effort?: string; firstPrompt?: string }
      | undefined
    const launched = commands.sessions.launch({
      target: { path: session.cwd, repoPath: session.cwd, machineId: row.machine.id },
      agentKind: row.kind,
      credentialId,
      ...(session.issueId ? { issueId: session.issueId } : {}),
      ...(input?.model ? { model: input.model } : {}),
      ...(input?.effort ? { effort: input.effort } : {}),
      ...(input?.firstPrompt ? { firstPrompt: input.firstPrompt } : {}),
    })
    void commands.sessions.killSession(session.sessionId)
    ui.navigateToSession(launched.sessionId)
  }
  return (
    <View style={{ gap: space.xs, padding: space.sm }}>
      {!installed ? (
        <Pressable
          accessibilityRole="button"
          disabled={
            answer.loading || !row.canAct || row.inventory?.management?.installable === false
          }
          style={{ minHeight: 44, justifyContent: 'center' }}
          onPress={() => {
            void answer.run(client, row, 'install').then(() => {
              if (!answer.answer?.ok) return
              setInstalled(true)
            })
          }}
        >
          <Text style={{ color: color.accentTint }}>
            {answer.loading ? 'Installing…' : 'Install a current version for Podium'}
          </Text>
        </Pressable>
      ) : (
        <>
          <Text style={{ color: color.textDim }}>
            Installed for Podium. Choose a credential; your own login stays in your folder.
          </Text>
          {choices.map(({ view, disabled }) => (
            <Pressable
              key={view.id}
              accessibilityRole="button"
              disabled={!!disabled}
              style={{ minHeight: 44, justifyContent: 'center' }}
              onPress={() => start(view.id)}
            >
              <Text style={{ color: color.accentTint }}>
                {view.label}
                {disabled ? ` · ${disabled}` : ''}
              </Text>
            </Pressable>
          ))}
          <Pressable
            accessibilityRole="button"
            style={{ minHeight: 44, justifyContent: 'center' }}
            onPress={() => router.push('/settings')}
          >
            <Text style={{ color: color.accentTint }}>Add a credential</Text>
          </Pressable>
        </>
      )}
      {(answer.error || answer.answer?.error) && (
        <Text accessibilityRole="alert" style={{ color: color.text }}>
          {answer.error ?? answer.answer?.error}
        </Text>
      )}
    </View>
  )
})
