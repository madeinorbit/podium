import { asSessionId, BUILTIN_HARNESS_KINDS } from '@podium/model'
import { createRoot } from 'react-dom/client'
import { StyleSheet, Text, View } from 'react-native'
import { HarnessChip } from '../src/components/AgentMark'
import { AgentSetupOnboarding } from '../src/components/AgentSetupOnboarding'
import { AgentSetupPanel } from '../src/components/AgentSetupPanel'
import { AgentSetupPickerEntry } from '../src/components/AgentSetupPickerEntry'
import { PressableScale } from '../src/components/PressableScale'
import SetupLoginTerminalDialog from '../src/components/SetupLoginTerminalDialog'
import { color, font, sans, space } from '../src/theme/theme'
import { installed, missing, setupFixture } from './agent-setup-fixture'

const mode = new URLSearchParams(window.location.search).get('state') ?? 'panel'
const onboarding = mode.startsWith('onboarding')
const fixture = setupFixture(
  onboarding
    ? {
        origin: { kind: 'onboarding' },
        agents: BUILTIN_HARNESS_KINDS.map((kind) =>
          kind === 'antigravity'
            ? {
                ...missing(kind),
                management: {
                  installable: false,
                  reason: 'This agent is not available for this platform.',
                },
              }
            : missing(kind),
        ),
      }
    : {},
)
if (mode === 'onboarding-ready') {
  fixture.machine.patch('claude-code', installed('claude-code'))
}
if (mode === 'harness' || mode === 'remove') fixture.view.openDetail('claude-code')
if (mode === 'remove') fixture.view.detail?.press('remove')
if (mode === 'signin') fixture.view.openDetail('pi')
if (mode === 'panel') fixture.view.toggle('codex')
if (mode === 'failed')
  fixture.machine.patch('cursor', {
    install: {
      managed: {
        paused: false,
        lastError: {
          at: '2026-11-23T10:00:00Z',
          message: 'The download was interrupted. Try again.',
        },
      },
    },
  })
function Picker() {
  return (
    <View style={styles.picker}>
      <Text style={styles.title}>Agent</Text>
      <Text style={styles.note}>Research machine</Text>
      <View style={styles.group}>
        {['claude-code', 'pi'].map((kind) => (
          <PressableScale
            key={kind}
            accessibilityRole="button"
            style={styles.row}
            onPress={() => {}}
          >
            <HarnessChip kind={kind} size={28} />
            <Text style={styles.label}>{kind === 'pi' ? 'Pi' : 'Claude Code'}</Text>
            {kind === 'pi' ? (
              <Text style={styles.note}>signed out</Text>
            ) : (
              <Text style={styles.note}>✓</Text>
            )}
          </PressableScale>
        ))}
      </View>
      <AgentSetupPickerEntry
        hint="1 installing"
        onPress={() => {
          location.search = '?state=panel'
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  canvas: {
    height: '100%',
    width: '100%',
    alignItems: 'center',
    backgroundColor: color.bgSunken,
  },
  phone: {
    width: '100%',
    maxWidth: 390,
    alignSelf: 'center',
    height: '100%',
    backgroundColor: color.bgSunken,
  },
  picker: {
    padding: space.lg,
    paddingTop: 44,
    backgroundColor: color.bgSunken,
    marginTop: 'auto',
    paddingBottom: 34,
  },
  title: { ...sans(600), fontSize: font.heading, color: color.text },
  note: { ...sans(), fontSize: font.tiny, color: color.textDim },
  group: { backgroundColor: color.bg, borderRadius: 12, marginTop: space.lg, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    minHeight: 52,
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
  },
  label: { ...sans(), fontSize: font.body, color: color.text, flex: 1 },
})

const root = document.getElementById('root')
if (!root) throw new Error('Missing harness root')
createRoot(root).render(
  <View style={styles.canvas}>
    <View style={[styles.phone, onboarding && { maxWidth: 560 }]}>
      {mode === 'picker' ? (
        <Picker />
      ) : onboarding ? (
        <AgentSetupOnboarding view={fixture.view} onContinue={async () => {}} />
      ) : (
        <AgentSetupPanel
          view={fixture.view}
          onClose={() => {}}
          loginTerminal={
            mode === 'login' ? (
              <SetupLoginTerminalDialog sessionId={asSessionId('login-session')} />
            ) : undefined
          }
          onCloseLogin={() => {}}
        />
      )}
    </View>
  </View>,
)
