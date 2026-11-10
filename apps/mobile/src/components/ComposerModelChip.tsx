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
  canConfigureModel,
  compactModelId,
  configureResultNotice,
  menuEffort,
  menuModel,
  modelReadoutReason,
  readoutEffort,
  readoutModel,
} from '@podium/client-core/values'
import { observer } from 'mobx-react-lite'
import { useCallback } from 'react'
import { Alert, StyleSheet, Text, View } from 'react-native'
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
 * changed. Every other session shows the same chip, and a tap (or its
 * accessibility hint) says why it cannot change here.
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
        onNotice?.(
          configureResultNotice(await trpc.sessions.configure.mutate({ sessionId, ...patch })).text,
        )
      } catch {
        onNotice?.(configureResultNotice(undefined).text)
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
    const text = chipText(
      modelLabel(agentKind, model, live, served),
      effortLabel(agentKind, effort),
    )
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
        {(onPress) =>
          // On iOS the SwiftUI Menu owns the tap (onPress is undefined): the
          // label must not be an RN responder, or it swallows the touch.
          onPress === undefined ? (
            <View
              accessible
              accessibilityRole="button"
              accessibilityLabel={`Model and effort: ${text}`}
              testID="session-model"
              style={styles.chip}
            >
              <Text style={styles.text} numberOfLines={1}>
                {text}
              </Text>
              <Icon as={ChevronDown} size={11} color={color.textDim} />
            </View>
          ) : (
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
          )
        }
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
  const reason = modelReadoutReason(session, verdict)
  // The same chip shape as the live menu (board ChatReply: name · effort and a
  // chevron). It cannot change here, so a tap says why instead of opening a
  // menu of choices that would be refused.
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`Model and effort: ${text}`}
      accessibilityHint={reason}
      testID="session-model"
      onPress={() => Alert.alert(text, reason)}
      hitSlop={8}
      scaleTo={0.97}
      style={styles.chip}
    >
      <Text style={styles.text} numberOfLines={1}>
        {text}
      </Text>
      <Icon as={ChevronDown} size={11} color={color.textMicro} />
    </PressableScale>
  )
})

function chipText(model: string | undefined, effort: string | undefined): string {
  return [model, effort].filter(Boolean).join(' · ')
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
})
