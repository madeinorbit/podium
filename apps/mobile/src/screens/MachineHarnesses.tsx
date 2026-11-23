import { useRequestClient } from '@podium/client-core/react'
import { isGone, LOADING } from '@podium/client-graph'
import { HarnessInstallAnswer } from '@podium/client-graph/harness-installs-view'
import type { MachineHarness } from '@podium/client-graph/machine-harness'
import { observer } from 'mobx-react-lite'
import { useEffect, useMemo, useState } from 'react'
import { Alert, Pressable, Text, View } from 'react-native'
import { useMobilePool } from '../client/mobile-pool'
import type { MobileTrpc } from '../client/trpc'
import { color, font, radius, space } from '../theme/theme'

/** Phone and desktop read the same machine model and harness state rules. */
export const PhoneMachineHarnesses = observer(function PhoneMachineHarnesses({
  machineId,
}: {
  machineId: string
}) {
  const [open, setOpen] = useState(false)
  const pool = useMobilePool()
  const machine = pool?.model('machine', machineId)
  if (!machine || machine === LOADING || isGone(machine)) return null
  return (
    <View style={{ paddingBottom: space.sm }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={{ minHeight: 44, justifyContent: 'center' }}
      >
        <Text style={{ color: color.accent, fontSize: font.body }}>
          {open ? 'Hide harnesses' : 'Harnesses'}
        </Text>
      </Pressable>
      {open && machine.harnessInstalls.map((row) => <PhoneHarnessRow key={row.kind} row={row} />)}
    </View>
  )
})

const PhoneHarnessRow = observer(function PhoneHarnessRow({ row }: { row: MachineHarness }) {
  const client = useRequestClient<MobileTrpc>()
  const answer = useMemo(() => new HarnessInstallAnswer(), [])
  useEffect(() => () => answer.close(), [answer])
  return (
    <View
      style={{
        borderTopWidth: 1,
        borderColor: color.border,
        paddingVertical: space.md,
        gap: space.xs,
      }}
    >
      <Text style={{ color: color.text, fontSize: font.body, fontWeight: '600' }}>{row.label}</Text>
      {row.ownLabel && <Text style={{ color: color.textDim }}>{row.ownLabel}</Text>}
      {row.managedLabel && <Text style={{ color: color.textDim }}>{row.managedLabel}</Text>}
      {row.updateNotice && <Text style={{ color: color.textDim }}>{row.updateNotice}</Text>}
      {row.inventory?.missingPrerequisites?.map((prerequisite) => (
        <Text key={prerequisite.executable} accessibilityRole="alert" style={{ color: color.text }}>
          {prerequisite.message}
        </Text>
      ))}
      {row.managed?.lastCheckAt && (
        <Text style={{ color: color.textDim }}>
          Checked {new Date(row.managed.lastCheckAt).toLocaleString()}
        </Text>
      )}
      {row.state === 'not-installed' && <Text style={{ color: color.textDim }}>Not installed</Text>}
      {row.state === 'unknown' && (
        <Text style={{ color: color.textDim }}>Installation not yet reported</Text>
      )}
      {row.sharing && (
        <Text style={{ color: color.textDim }}>
          Both installs are sharing one folder for settings and conversations.
        </Text>
      )}
      {row.installReason && !row.managed && (
        <Text style={{ color: color.textDim }}>{row.installReason}</Text>
      )}
      {row.managed?.lastError && (
        <Text accessibilityRole="alert" style={{ color: color.text }}>
          {row.managed.lastError.message}
        </Text>
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
        {row.actions.map((action) => {
          const disabled =
            !row.canAct ||
            answer.loading ||
            (action === 'install' && row.inventory?.management?.installable === false)
          return (
            <Pressable
              key={action}
              accessibilityRole="button"
              accessibilityState={{ disabled }}
              disabled={disabled}
              style={{
                minHeight: 44,
                justifyContent: 'center',
                paddingHorizontal: space.sm,
                borderWidth: 1,
                borderColor: color.border,
                borderRadius: radius.sm,
                opacity: disabled ? 0.5 : 1,
              }}
              onPress={() => {
                const run = () => {
                  void answer.run(client, row, action)
                }
                if (action === 'remove')
                  Alert.alert(
                    `Remove Podium’s copy of ${row.label}?`,
                    'Releases will be deleted once their running sessions exit. Your Podium home, conversations and sign-in folders will stay.',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Remove', style: 'destructive', onPress: run },
                    ],
                  )
                else run()
              }}
            >
              <Text style={{ color: color.accent }}>{row.actionLabel(action)}</Text>
            </Pressable>
          )
        })}
      </View>
      {answer.loading && (
        <Text accessibilityRole="text" style={{ color: color.textDim }}>
          Waiting for the machine…
        </Text>
      )}
      {(answer.error || answer.answer?.error) && (
        <Text accessibilityRole="alert" style={{ color: color.text }}>
          {answer.error ?? answer.answer?.error}
        </Text>
      )}
      {answer.answer?.pendingSessions ? (
        <Text style={{ color: color.textDim }}>
          Removal waits for {answer.answer.pendingSessions} running sessions. Homes and
          conversations are kept.
        </Text>
      ) : null}
      {answer.answer?.conversations && (
        <View style={{ gap: space.xs }}>
          <Text style={{ color: color.text }}>
            {answer.answer.homeExists
              ? 'Conversations in the Podium home:'
              : 'There is no Podium home.'}
          </Text>
          {answer.answer.conversations.map((item) => (
            <Text key={item.id} style={{ color: color.textDim }}>
              {item.title} ({item.id})
            </Text>
          ))}
          {answer.answer.homeExists && (
            <Pressable
              accessibilityRole="button"
              disabled={answer.loading}
              style={{ minHeight: 44, justifyContent: 'center' }}
              onPress={() => {
                const conversations = answer.answer?.conversations ?? []
                Alert.alert(
                  `Delete the Podium home of ${row.label}?`,
                  `This deletes these conversations: ${conversations.length ? conversations.map((item) => item.title).join(', ') : '(none)'}. Sign-in folders stay.`,
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Delete home',
                      style: 'destructive',
                      onPress: () => {
                        void answer.run(
                          client,
                          row,
                          'remove-home',
                          conversations.map((item) => item.id),
                        )
                      },
                    },
                  ],
                )
              }}
            >
              <Text style={{ color: color.accent }}>Delete Podium home</Text>
            </Pressable>
          )}
        </View>
      )}
      {answer.answer?.changes?.length === 0 && (
        <Text style={{ color: color.textDim }}>No Podium changes recorded.</Text>
      )}
      {answer.answer?.changes?.map((change) => (
        <View key={change.id}>
          <Text style={{ color: color.text }}>{change.file}</Text>
          <Text style={{ color: color.textDim }}>
            {change.edit.kind === 'owned-file'
              ? 'File created by Podium'
              : change.edit.kind === 'hook-handlers'
                ? `Podium’s hooks for ${change.edit.events.length} events`
                : `${change.edit.path.join('.')} = ${JSON.stringify(change.edit.value)}`}
          </Text>
          {change.status && (
            <Text style={{ color: color.textDim }}>
              {change.status === 'changed'
                ? 'Kept: you changed this after Podium wrote it.'
                : change.status === 'restored'
                  ? 'Restored.'
                  : (change.reason ?? 'Could not restore.')}
            </Text>
          )}
        </View>
      ))}
    </View>
  )
})
