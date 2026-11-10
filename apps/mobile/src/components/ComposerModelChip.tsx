import {
  effortLabel,
  effortOptionsForModel,
  issueAgentKind,
  modelLabel,
  modelOptions,
} from '@podium/client-core/agent-models'
import { useHarnessDescriptors, useModelCatalog, useStoreHandle } from '@podium/client-core/react'
import type { SessionView } from '@podium/client-core/session-values'
import {
  type ConfigurableVerdict,
  canConfigureModel,
  compactModelId,
  menuEffort,
  menuModel,
  readoutEffort,
  readoutModel,
} from '@podium/client-core/values'
import { observer } from 'mobx-react-lite'
import { useCallback } from 'react'
import { StyleSheet, Text } from 'react-native'
import type { MobileTrpc } from '../client/trpc'
import { color, font, mono } from '../theme/theme'
import { ComposerModelMenu, type ComposerModelMenuProps } from './ComposerModelMenu'
import { Icon } from './Icon'
import { ChevronDown } from './icons'
import { PressableScale } from './PressableScale'

/** The session facts the chip reads, the same set the web chip reads. */
export type ModelChipSession = Pick<
  SessionView,
  | 'sessionId'
  | 'agentKind'
  | 'machineId'
  | 'status'
  | 'configureFields'
  | 'observedModel'
  | 'observedEffort'
  | 'requestedModel'
  | 'requestedEffort'
  | 'model'
  | 'effort'
>

/**
 * THE SESSION'S MODEL · EFFORT CHIP, in the composer where the next message is
 * written (POD-2380, the phone half of the web's POD-6264 chip).
 *
 * The same rule decides both faces: a running session whose live driver lists
 * `model` in `configureFields` opens a native menu of models with an Effort
 * submenu, and each pick sends `sessions.configure` with only the field that
 * changed. Every other session shows the same words as a readout whose
 * accessibility hint says why it cannot change here.
 */
export const ComposerModelChip = observer(function ComposerModelChip({
  session,
  onNotice,
}: {
  session: ModelChipSession | undefined
  /** One short sentence about the result of a change, for the composer caption. */
  onNotice?: (text: string) => void
}) {
  const agentKind = issueAgentKind(session?.agentKind)
  const catalog = useModelCatalog<MobileTrpc>(session?.machineId ?? undefined)
  const { served } = useHarnessDescriptors<MobileTrpc>(session?.machineId ?? undefined)
  const trpc = useStoreHandle<MobileTrpc>().access.trpc
  const sessionId = session?.sessionId
  // PATCH-shaped, as on the web: the other sticky choice stays as it was.
  const configure = useCallback(
    async (patch: { model?: string; effort?: string }) => {
      if (!sessionId) return
      try {
        const result = await trpc.sessions.configure.mutate({ sessionId, ...patch })
        if ('ok' in result) {
          onNotice?.(
            result.effective === 'next-turn'
              ? 'The change applies from the next turn.'
              : 'The running session changed.',
          )
          return
        }
        onNotice?.(result.detail ?? `Could not change the running session (${result.reason}).`)
      } catch {
        onNotice?.('Could not change the running session.')
      }
    },
    [sessionId, trpc, onNotice],
  )
  if (!session || !agentKind) return null
  const live = catalog[agentKind]
  const verdict = canConfigureModel(session)

  if (verdict === 'yes' && session.status === 'live') {
    const model = menuModel(session)
    const effort = menuEffort(session)
    const efforts =
      session.configureFields?.includes('effort') === true
        ? effortOptionsForModel(agentKind, model, live, served)
        : []
    const text = chipText(modelLabel(agentKind, model, live, served), effortLabel(agentKind, effort))
    const menu: Omit<ComposerModelMenuProps, 'children'> = {
      models: modelOptions(agentKind, live, served),
      model,
      efforts,
      effort,
      effortLabel: effortLabel(agentKind, effort),
      onModel: (next) => {
        if (next !== model) void configure({ model: next })
      },
      onEffort: (next) => {
        if (next !== effort) void configure({ effort: next })
      },
    }
    return (
      <ComposerModelMenu {...menu}>
        {(onPress) => (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Model and effort: ${text}`}
            testID="session-model"
            onPress={onPress}
            hitSlop={8}
            scaleTo={0.97}
            style={styles.chip}
          >
            <Text style={styles.text} numberOfLines={1}>
              {text}
            </Text>
            <Icon as={ChevronDown} size={11} color={color.textDim} />
          </PressableScale>
        )}
      </ComposerModelMenu>
    )
  }

  const raw = readoutModel(session)
  const rawEffort = readoutEffort(session)
  if (!raw && !rawEffort) return null
  const listed = raw ? modelLabel(agentKind, raw, live, served) : undefined
  // Not in the machine's catalog: still a name, not an id.
  const model = raw && listed === raw ? compactModelId(raw) : listed
  const text = chipText(model, rawEffort ? effortLabel(agentKind, rawEffort) : undefined)
  return (
    <Text
      testID="session-model"
      accessibilityLabel={text}
      accessibilityHint={readoutReason(session, verdict)}
      style={[styles.text, styles.readout]}
      numberOfLines={1}
    >
      {text}
    </Text>
  )
})

function chipText(model: string | undefined, effort: string | undefined): string {
  return [model, effort].filter(Boolean).join(' · ')
}

/** Why this session's model cannot change from here: the web chip's sentence. */
export function readoutReason(
  session: Pick<ModelChipSession, 'observedModel' | 'requestedModel'>,
  verdict: ConfigurableVerdict,
): string {
  const provenance = session.observedModel
    ? 'The model this agent is running, read from its transcript.'
    : session.requestedModel
      ? 'Requested on the running session; it applies from the next message.'
      : 'Requested at launch; not yet seen in the transcript.'
  const capability =
    verdict === 'no'
      ? 'This harness takes its model and effort at launch, so they cannot change mid-conversation.'
      : verdict === 'yes'
        ? 'The session is not running. Wake it to change its model or effort.'
        : 'This session has not reported whether its model can change while it runs.'
  return `${provenance} ${capability}`
}

const styles = StyleSheet.create({
  /** One line that gives up width first: the trailing controls are fixed. */
  chip: {
    flexShrink: 1,
    minWidth: 0,
    height: 32,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  text: {
    ...mono(400),
    flexShrink: 1,
    minWidth: 0,
    color: color.textDim,
    fontSize: font.micro,
    lineHeight: 16,
  },
  readout: {
    paddingVertical: 8,
  },
})
