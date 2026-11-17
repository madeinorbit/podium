import { effortLabel, issueAgentKind, modelName } from '@podium/client-core/agent-models'
import { useHarnessDescriptors, useModelCatalog } from '@podium/client-core/react'
import type { SessionView } from '@podium/client-core/session-values'
import { readoutEffort, readoutModel } from '@podium/client-core/values'
import { here } from '@podium/client-graph/lookup'
import type { SessionModel } from '@podium/client-graph/models'
import { observer } from 'mobx-react-lite'
import { StyleSheet, Text } from 'react-native'
import type { MobileTrpc } from '../client/trpc'
import { color, font, leading, sans } from '../theme/theme'
import { useLiveInk } from '../theme/use-live-ink'

/** The session's model and effort are information in chat; launch sheets own selection. */
export const ComposerModelLabel = observer(function ComposerModelLabel({
  session,
}: {
  session: SessionModel | undefined
}) {
  // Runtime-requested model and effort are on the resident row, not declared
  // SessionModel fields. Use the same row as the deck and detail readouts.
  const view = session ? (here(session.row) as unknown as SessionView | undefined) : undefined
  const agentKind = issueAgentKind(view?.agentKind)
  const catalog = useModelCatalog<MobileTrpc>(view?.machineId ?? undefined)
  const { served } = useHarnessDescriptors<MobileTrpc>(view?.machineId ?? undefined)
  const ink = useLiveInk(color.textDim)
  if (!view || !agentKind) return null

  const raw = readoutModel(view)
  const rawEffort = readoutEffort(view)
  if (!raw && !rawEffort) return null
  const text = [
    raw ? modelName(agentKind, raw, catalog[agentKind], served) : undefined,
    rawEffort ? effortLabel(agentKind, rawEffort) : undefined,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <Text
      accessible
      accessibilityRole="text"
      accessibilityLabel={`Model and effort: ${text}`}
      testID="session-model"
      allowFontScaling
      maxFontSizeMultiplier={2}
      numberOfLines={2}
      ellipsizeMode="tail"
      style={[styles.label, { color: ink }]}
    >
      {text}
    </Text>
  )
})

const styles = StyleSheet.create({
  label: {
    ...sans(400),
    flexShrink: 1,
    minWidth: 0,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny),
  },
})
