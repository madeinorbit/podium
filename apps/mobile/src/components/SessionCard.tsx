import { agentColorHex, type DotTone, type SessionCardModel } from '@podium/client-core/viewmodels'
import type { IssueWire } from '@podium/protocol'
import { StyleSheet, Text, View } from 'react-native'
import { flow, issueColorHex } from '../theme/issueColors'
import { alpha } from '../theme/mix'
import { type AttentionTone, color, font, mono, radius, sans, space, tone } from '../theme/theme'
import { IdSquare, type IdSquareState } from './IdSquare'
import { PressableScale } from './PressableScale'
import { BrailleSpinner } from './StatusGlyphs'
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

const SQUARE_STATE: Record<DotTone, IdSquareState> = {
  working: 'working',
  attention: 'waiting',
  error: 'waiting',
  ready: 'idle',
  neutral: 'idle',
}

/**
 * One session row in the redesign's work-list grammar: the 26px ID square is
 * the identity mark, the row tints in the issue's colour (slate-quiet when
 * uncoloured), status lives as a glyph column on the right. Needs-you rows are
 * the heroes — amber border + tint, the agent's actual question quoted below.
 */
export function SessionCard({
  model,
  issue,
  agentColor,
  onPress,
  children,
}: {
  model: SessionCardModel
  issue?: IssueWire
  agentColor?: string
  onPress: () => void
  children?: React.ReactNode
}) {
  const toneKey = DOT_TONE[model.dotTone]
  const needsYou = model.group === 'needsYou'
  const working = model.dotTone === 'working'
  const hex = issue ? issueColorHex(issue.color) : undefined
  const identity = agentColorHex(agentColor) ?? color.idle
  const initial = (model.title.trim()[0] ?? '?').toUpperCase()

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={model.title}
      onPress={onPress}
      style={[
        styles.row,
        hex ? { backgroundColor: flow.rowBg(hex) } : styles.rowNeutral,
        needsYou && styles.rowNeedsYou,
      ]}
    >
      <View style={styles.topRow}>
        {issue ? (
          <IdSquare
            issue={issue}
            state={SQUARE_STATE[model.dotTone]}
            ringColor={hex ? flow.rowBg(hex) : color.surface}
          />
        ) : (
          <View style={[styles.avatar, { borderColor: alpha(identity, 0.45) }]}>
            <Text style={[mono(600), styles.avatarText, { color: identity }]}>{initial}</Text>
          </View>
        )}
        <View style={styles.titles}>
          <Text style={[styles.title, hex ? { color: flow.text(hex) } : null]} numberOfLines={1}>
            {model.title}
          </Text>
          <Text
            style={[styles.subtitle, hex ? { color: flow.muted(hex) } : null]}
            numberOfLines={1}
          >
            {model.subtitle}
          </Text>
        </View>
        <View style={styles.status}>
          {working ? <BrailleSpinner size={11} /> : <StatusDot toneKey={toneKey} />}
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
  row: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'transparent',
    marginHorizontal: space.sm + 2,
    marginBottom: 3,
    paddingHorizontal: 9,
    paddingVertical: 7,
    gap: 6,
  },
  rowNeutral: {
    backgroundColor: color.surface,
  },
  rowNeedsYou: {
    backgroundColor: 'rgba(245, 158, 11, 0.08)',
    borderColor: color.needsYouBorder,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  avatar: {
    width: 26,
    height: 26,
    borderRadius: radius.md,
    borderWidth: 1,
    backgroundColor: color.elevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 11,
  },
  titles: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  title: {
    ...sans(500),
    color: color.text,
    fontSize: font.small,
    letterSpacing: -0.1,
  },
  subtitle: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.tiny,
  },
  status: {
    alignItems: 'flex-end',
    gap: space.xs,
  },
  issue: {
    ...mono(500),
    color: color.textDim,
    fontSize: font.micro,
  },
  summary: {
    ...sans(400),
    color: color.textDim,
    fontSize: 11.5,
    lineHeight: 16,
  },
  quote: {
    backgroundColor: tone.needsYou.bg,
    borderLeftWidth: 3,
    borderLeftColor: color.needsYou,
    borderRadius: radius.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  quoteText: {
    ...sans(500),
    color: color.accentTint,
    fontSize: 11.5,
    lineHeight: 16,
  },
})
