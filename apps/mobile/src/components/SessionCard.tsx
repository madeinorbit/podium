import { agentColorHex, type DotTone, type SessionCardModel } from '@podium/client-core/viewmodels'
import type { IssueWire, SessionMeta } from '@podium/model'
import { StyleSheet, Text, View } from 'react-native'
import { flow, issueColorHex } from '../theme/issueColors'
import { alpha } from '../theme/mix'
import {
  type AttentionTone,
  color,
  font,
  leading,
  mono,
  radius,
  sans,
  space,
  tone,
} from '../theme/theme'
import { IdSquare, type IdSquareState } from './IdSquare'
import { PressableScale } from './PressableScale'
import { Pill, StatusDot } from './ui'
import { WorkingMark } from './WorkingMark'

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
 * A DRAFT chat that has never started has no liveness to report, so it earns
 * no status dot at all: the ready-blue dot on a freshly minted, never-spoken-to
 * draft read as "something is live here" when nothing was (round 2, item 4).
 *
 * Gated on the actual facts, not on the draft flag alone: the moment the agent
 * reports ANY runtime state — a turn started (`working`), a question
 * (`attention`), an error, or idle-after-a-turn — the dot comes back, because
 * those states are live regardless of whether the vessel is still a draft.
 * Non-live tones only, so an offer-carrying draft (attention with no
 * agentState) keeps its amber dot.
 */
export function hidesDraftDot(
  model: Pick<SessionCardModel, 'dotTone'>,
  issue: Pick<IssueWire, 'draft'> | undefined,
  session: Pick<SessionMeta, 'agentState' | 'busy'> | undefined,
): boolean {
  if (!issue?.draft || !session) return false
  if (model.dotTone !== 'ready' && model.dotTone !== 'neutral') return false
  const phase = session.agentState?.phase
  return (phase === undefined || phase === 'unknown') && !session.busy
}

/**
 * One session row in the redesign's work-list grammar: the 26px ID square is
 * the identity mark, the row tints in the issue's colour (slate-quiet when
 * uncoloured), status lives as a glyph column on the right. Needs-you rows are
 * the heroes — bisque border + tint, the agent's actual question quoted below.
 */
export function SessionCard({
  model,
  issue,
  session,
  agentColor,
  onPress,
  onLongPress,
  children,
}: {
  model: SessionCardModel
  issue?: IssueWire
  /** The row's session, for the draft-dot gate ({@link hidesDraftDot}).
   *  Optional so existing call sites keep today's behaviour untouched. */
  session?: SessionMeta
  agentColor?: string
  onPress: () => void
  /** Long-press peek (the task peek sheet) — forwarded to the pressable. */
  onLongPress?: () => void
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
      onLongPress={onLongPress}
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
          {working ? (
            <WorkingMark size={12} />
          ) : hidesDraftDot(model, issue, session) ? null : (
            <StatusDot toneKey={toneKey} />
          )}
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
    backgroundColor: alpha(color.needsYou, 0.08),
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
    fontSize: font.tiny,
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
    fontSize: font.small,
    lineHeight: leading(font.small),
  },
  quote: {
    backgroundColor: tone.needsYou.bg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tone.needsYou.border,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  quoteText: {
    ...sans(500),
    color: color.accentTint,
    fontSize: font.small,
    lineHeight: leading(font.small, 'prose'),
  },
})
