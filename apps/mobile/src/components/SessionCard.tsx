import type { AttentionGroup } from '@podium/client-core/focus'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { type AttentionTone, color, font, radius, space, tone } from '../theme/theme'
import type { SessionCardModel } from '../viewModels/sessionCard'
import { Pill, StatusDot } from './ui'

export type { SessionCardModel }

const GROUP_TONE: Record<AttentionGroup, AttentionTone> = {
  needsYou: 'needsYou',
  idle: 'idle',
  working: 'working',
}

/**
 * One session on the board. Needs-you cards carry an accent rail and surface the
 * agent's actual question; everything else stays quiet.
 */
export function SessionCard({
  model,
  onPress,
  children,
}: {
  model: SessionCardModel
  onPress: () => void
  children?: React.ReactNode
}) {
  const toneKey = GROUP_TONE[model.group]
  const needsYou = model.group === 'needsYou'
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={model.title}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        needsYou && styles.cardNeedsYou,
        pressed && styles.cardPressed,
      ]}
    >
      <View style={styles.topRow}>
        <StatusDot toneKey={toneKey} />
        <Text style={styles.title} numberOfLines={1}>
          {model.title}
        </Text>
        {model.queuedCount ? <Pill label={`${model.queuedCount} queued`} /> : null}
      </View>
      <Text style={styles.subtitle} numberOfLines={1}>
        {model.subtitle}
      </Text>
      {model.issueLabel ? (
        <Text style={styles.issue} numberOfLines={1}>
          {model.issueLabel}
        </Text>
      ) : null}
      {model.summary ? (
        <Text style={[styles.summary, needsYou && { color: tone.needsYou.fg }]} numberOfLines={3}>
          {model.summary}
        </Text>
      ) : null}
      {children}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.card,
    borderColor: color.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    padding: space.md,
    gap: 4,
  },
  cardNeedsYou: {
    borderLeftWidth: 3,
    borderLeftColor: color.needsYou,
  },
  cardPressed: {
    backgroundColor: color.cardPressed,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  title: {
    flex: 1,
    color: color.text,
    fontSize: font.body,
    fontWeight: '600',
  },
  subtitle: {
    color: color.textFaint,
    fontSize: font.tiny,
  },
  issue: {
    color: color.accent,
    fontSize: font.tiny,
  },
  summary: {
    color: color.textDim,
    fontSize: font.small,
    lineHeight: 19,
    marginTop: 2,
  },
})
