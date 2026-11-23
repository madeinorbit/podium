import { useCommands, useHarnessDescriptors, useRequestClient } from '@podium/client-core/react'
import type { MachineModel } from '@podium/client-graph'
import {
  type AgentSetupOrigin,
  type AgentSetupPreferences,
  AgentSetupView,
} from '@podium/client-graph/agent-setup-view'
import { here } from '@podium/client-graph/lookup'
import { myPreferences } from '@podium/client-graph/per-user-records'
import { RecordRequest } from '@podium/client-graph/requested-records'
import { sessionCredentialChoices } from '@podium/client-graph/session-credential-facts'
import { BUNDLED_DESCRIPTORS } from '@podium/harness/browser'
import type { BuiltinHarnessKind, CredentialView } from '@podium/model'
import { observer } from 'mobx-react-lite'
import { lazy, Suspense, useEffect, useMemo, useRef } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import { useMobilePool } from '../client/mobile-pool'
import type { MobileTrpc } from '../client/trpc'
import { color } from '../theme/theme'
import { AgentSetupOnboarding } from './AgentSetupOnboarding'
import { AgentSetupPanel } from './AgentSetupPanel'
import { BottomSheet } from './BottomSheet'
import { PressableScale } from './PressableScale'

const LoginTerminal = lazy(() => import('./SetupLoginTerminalDialog'))

export interface AgentSetupSheetProps {
  machineId: string
  origin: AgentSetupOrigin['kind']
  focus?: BuiltinHarnessKind
  onStart?: (harness: BuiltinHarnessKind) => void
  onClose: () => void
  /** Full-screen onboarding persists completion before releasing the work screen. */
  onContinue?: () => Promise<void>
}

/** Mounted only for an opening, so its request answers never outlive the sheet. */
export const PhoneAgentSetupSheet = observer(function PhoneAgentSetupSheet(
  props: AgentSetupSheetProps,
) {
  const pool = useMobilePool()
  const machine = pool ? here(pool.model('machine', props.machineId)) : undefined
  return machine ? (
    <ConnectedSetup {...props} machine={machine} />
  ) : (
    <BottomSheet
      visible
      mode="detented"
      onClose={props.onClose}
      head={
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Done"
          onPress={props.onClose}
          style={{
            minHeight: 44,
            alignItems: 'flex-end',
            justifyContent: 'center',
            paddingHorizontal: 16,
          }}
        >
          <Text style={{ color: color.accentTint }}>Done</Text>
        </PressableScale>
      }
    >
      <View style={{ padding: 16 }}>
        <Text style={{ color: color.textDim }}>
          Agent setup is not available yet for this machine.
        </Text>
      </View>
    </BottomSheet>
  )
})

const ConnectedSetup = observer(function ConnectedSetup({
  machine,
  ...props
}: AgentSetupSheetProps & { machine: MachineModel }) {
  const pool = useMobilePool()!
  const client = useRequestClient<MobileTrpc>()
  const commands = useCommands<MobileTrpc>()
  const { served } = useHarnessDescriptors<MobileTrpc>(machine.id)
  const callbacks = useRef(props)
  callbacks.current = props
  const descriptors = useRef(served)
  descriptors.current = served
  const credentials = useMemo(
    () => new RecordRequest(pool, 'credential', (record) => record.id),
    [pool],
  )
  const preferences = useMemo<AgentSetupPreferences>(
    () => ({
      credentialDefaults: () => myPreferences(pool)?.credentialDefaults ?? {},
      saveCredentialDefaults: (next) =>
        commands.preferences.setPreferences({ credentialDefaults: next }),
      savedCredentials: (harness) =>
        sessionCredentialChoices({
          views: credentials.models as unknown as readonly CredentialView[],
          accepts:
            (descriptors.current ?? BUNDLED_DESCRIPTORS).find(
              (descriptor) => descriptor.kind === harness,
            )?.accepts ?? [],
          machineId: machine.id,
          custodianOf: () => machine.custodian,
        })
          .filter((choice) => !choice.disabled)
          .map(({ view }) => ({ id: view.id, label: view.label })),
    }),
    [pool, credentials, commands, machine],
  )
  const view = useMemo(
    () =>
      new AgentSetupView({
        machine,
        client,
        preferences,
        origin: { kind: props.origin, onStart: (harness) => callbacks.current.onStart?.(harness) },
        ...(props.focus ? { focus: props.focus } : {}),
      }),
    [machine, client, preferences, props.origin, props.focus],
  )
  useEffect(() => {
    void credentials.read(() => client.credentials.list.query())
    return () => credentials.dispose()
  }, [credentials, client])
  useEffect(() => () => view.close(), [view])
  const signingIn = view.items.find((item) => item.signIn.loginSessionId !== null)
  const loginTerminal = signingIn?.signIn.loginSessionId ? (
    <Suspense fallback={<ActivityIndicator color={color.working} />}>
      <LoginTerminal sessionId={signingIn.signIn.loginSessionId} />
    </Suspense>
  ) : undefined
  if (props.onContinue) {
    return (
      <AgentSetupOnboarding
        view={view}
        onContinue={props.onContinue}
        onCloseLogin={() => signingIn?.signIn.closeLogin()}
        loginTerminal={loginTerminal}
      />
    )
  }
  return (
    <AgentSetupPanel
      view={view}
      onClose={props.onClose}
      onCloseLogin={() => signingIn?.signIn.closeLogin()}
      loginTerminal={loginTerminal}
    />
  )
})
