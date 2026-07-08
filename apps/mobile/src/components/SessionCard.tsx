import { agentColorHex, type DotTone } from '@podium/client-core/viewmodels'
import { StyleSheet, Text, View } from 'react-native'
import { type AttentionTone, color, elevation, font, radius, space, tone } from '../theme/theme'
import type { SessionCardModel } from '../viewModels/sessionCard'
import { PressableScale } from './PressableScale'
import { Pill, StatusDot } from './ui'

export type { SessionCardModel }

/** Shared dot semantics (sessionDotTone) → this theme's tone palette. */
const DOT_TONE: Record<DotTone, AttentionTone> = {
  working: 'working',
  attention: 'needsYou',
  error: 'danger',
  ready: 'accent',
  neutral: 'idle',
}

/**
 * One session on the board. Needs-you cards are the heroes: warmer surface,
 * amber glow, the agent's actual question in a quote block. Idle/working rows
 * stay compact and quiet. The agent's self-chosen identity color paints the
 * avatar square so you can tell your agents apart at a glance.
 */
export function SessionCard({
  model,
  agentColor,
  onPress,
  children,
}: {
  model: SessionCardModel
  agentColor?: string
  onPress: () => void
  children?: React.ReactNode
}) {
  const toneKey = DOT_TONE[model.dotTone]
  const needsYou = model.group === 'needsYou'
  const identity = agentColorHex(agentColor) ?? color.accent
  const initial = (model.title.trim()[0] ?? '?').toUpperCase()

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={model.title}
      onPress={onPress}
      style={[
        styles.card,
        elevation.card,
        needsYou && styles.cardNeedsYou,
        needsYou && (elevation.glow('rgba(255, 180, 84, 0.16)') as object),
      ]}
    >
      <View style={styles.topRow}>
        <View
          style={[
            styles.avatar,
            { backgroundColor: `${identity}22`, borderColor: `${identity}55` },
          ]}
        >
          <Text style={[styles.avatarText, { color: identity }]}>{initial}</Text>
        </View>
        <View style={styles.titles}>
          <Text style={styles.title} numberOfLines={1}>
            {model.title}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {model.subtitle}
          </Text>
        </View>
        <View style={styles.status}>
          <StatusDot toneKey={toneKey} />
          {model.queuedCount ? (
            <Pill label={`${model.queuedCount} queued`} toneKey="accent" />
          ) : null}
        </View>
      </View>
      {model.issueLabel ? (
        <Text style={styles.issue} numberOfLines={1}>
          {model.issueLabel}
        </Text>
      ) : null}
      {model.summary ? (
        needsYou ? (
          <View style={styles.quote}>
            <Text style={styles.quoteText} numberOfLines={3}>
              {model.summary}
            </Text>
          </View>
        ) : (
          <Text style={styles.summary} numberOfLines={2}>
            {model.summary}
          </Text>
        )
      ) : null}
      {children}
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.surface,
    borderColor: color.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    marginHorizontal: space.lg,
    marginBottom: space.md,
    padding: space.lg,
    gap: space.sm,
  },
  cardNeedsYou: {
    backgroundColor: '#191720',
    borderColor: color.needsYouBorder,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: radius.sm,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: font.heading,
    fontWeight: '800',
  },
  titles: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  title: {
    color: color.text,
    fontSize: font.body,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  subtitle: {
    color: color.textFaint,
    fontSize: font.tiny,
    fontWeight: '500',
  },
  status: {
    alignItems: 'flex-end',
    gap: space.xs,
  },
  issue: {
    color: color.accent,
    fontSize: font.tiny,
    fontWeight: '600',
  },
  summary: {
    color: color.textDim,
    fontSize: font.small,
    lineHeight: 19,
  },
  quote: {
    backgroundColor: tone.needsYou.bg,
    borderLeftWidth: 3,
    borderLeftColor: color.needsYou,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
  },
  quoteText: {
    color: '#ffd9a3',
    fontSize: font.small,
    lineHeight: 19,
    fontWeight: '500',
  },
})
