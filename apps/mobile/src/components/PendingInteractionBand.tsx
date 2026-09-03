import {
  type PendingInteractionAction,
  type PendingInteractionCard,
  pendingInteractionCards,
} from '@podium/client-core/viewmodels'
import type { SessionId } from '@podium/model'
import type { PendingInteractionWire } from '@podium/protocol'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useStoreSelector } from '@podium/client-core/react'
import type { MobileTrpc } from '../client/trpc'
import { color, font, leading, monoLabel, radius, sans, space } from '../theme/theme'
import { PressableScale } from './PressableScale'

/**
 * THE BLOCKED-SESSION BAND (POD-2414; spec §4).
 *
 * The phone's half of "every blocking ask renders in the web UI, the Tray,
 * mobile, and any attached CLI simultaneously". Until this existed the phone
 * could see a session sitting in `needs_user` and could answer exactly one shape
 * of ask — an AskUserQuestion the transcript happened to carry. A session
 * blocked on credentials, on a plan verdict, on an MCP elicitation or on a
 * failure it could not retry past showed nothing at all.
 *
 * WHICH BUTTONS APPEAR IS NOT DECIDED HERE. `pendingInteractionCards` is shared
 * with the desktop bar, and it is what knows that a keystroke permission cannot
 * be pressed safely (POD-707), that an elicitation needs a form this band does
 * not draw, and that a readable question is better rendered by
 * {@link AskQuestionCard} above the composer. This file is a band, a mutation
 * and an error line.
 *
 * IT SITS IN THE COMPOSER LAYER, above the ask card, for the same reason the
 * desktop bar sits above the composer: a blocking ask that scrolls out of the
 * feed is the failure the aggregate exists to remove.
 */
const NO_ASKS: PendingInteractionWire[] = []

export function PendingInteractionBand({ sessionId }: { sessionId: SessionId }) {
  // `?? NO_ASKS` with a module-level constant: a replica whose
  // `pendingInteraction` collection has not arrived is a partial world, not an
  // error, and this band must never be why the conversation above it fails.
  const rows = useStoreSelector<PendingInteractionWire[], MobileTrpc>(
    (s) => s.pendingInteractions ?? NO_ASKS,
  )
  const trpc = useStoreSelector<MobileTrpc, MobileTrpc>((s) => s.trpc)
  const [sending, setSending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const cards = pendingInteractionCards(rows, sessionId).filter(
    (card) => card.surface === 'aggregate',
  )
  if (cards.length === 0) return null

  const answer = async (card: PendingInteractionCard, action: PendingInteractionAction) => {
    if (sending !== null) return
    setSending(`${card.id}:${action.id}`)
    setError(null)
    try {
      // NOTHING OPTIMISTIC. The feed carries the OPEN set only, so a resolved
      // ask is removed from the replica and this band unmounts itself — a local
      // "sent" state would be a second source of truth for one row.
      const outcome = await trpc.interactions.answer.mutate({
        id: card.id,
        answer: action.answer,
      })
      if (!outcome.ok) setError(outcome.detail ?? outcome.reason ?? 'That answer was refused.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send that answer.')
    } finally {
      setSending(null)
    }
  }

  return (
    <View style={styles.layer}>
      {cards.map((card) => (
        <View key={card.id} style={styles.band} testID="pending-interaction">
          <View style={styles.headerRow}>
            {/* The same signal the ask band above it draws — one dot, one
                mono eyebrow, one rule. The two are the only places on this
                screen an agent stops for the operator, so they read as one
                component family rather than as two notices. */}
            <View style={styles.dot} />
            <Text style={styles.badge}>{card.title.toUpperCase()}</Text>
            <View style={styles.rule} />
          </View>
          <Text style={styles.detail}>{card.detail}</Text>
          {card.note !== undefined ? <Text style={styles.note}>{card.note}</Text> : null}
          {card.actions.length > 0 ? (
            <View style={styles.actions}>
              {card.actions.map((action) => (
                <PressableScale
                  key={action.id}
                  testID={`pending-interaction-action-${action.id}`}
                  disabled={sending !== null}
                  onPress={() => {
                    void answer(card, action)
                  }}
                  style={({ pressed }) => [
                    styles.action,
                    action.tone === 'primary' && styles.actionPrimary,
                    action.tone === 'danger' && styles.actionDanger,
                    pressed && styles.actionPressed,
                    sending !== null && styles.actionDisabled,
                  ]}
                >
                  <Text
                    style={[
                      styles.actionLabel,
                      action.tone === 'primary' && styles.actionPrimaryLabel,
                      action.tone === 'danger' && styles.actionDangerLabel,
                    ]}
                    numberOfLines={1}
                  >
                    {action.label}
                  </Text>
                </PressableScale>
              ))}
            </View>
          ) : null}
          {error !== null ? <Text style={styles.error}>{error}</Text> : null}
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  layer: {
    backgroundColor: color.engraved,
  },
  band: {
    backgroundColor: color.needsYouBg,
    borderTopColor: color.needsYouBorder,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 13,
    paddingVertical: 13,
    gap: space.sm,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: color.needsYou,
  },
  rule: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.needsYouBorder,
  },
  badge: {
    ...monoLabel(),
    color: color.needsYouText,
  },
  detail: {
    ...sans(500),
    color: color.text,
    fontSize: font.small,
    lineHeight: leading(font.small, 'prose'),
  },
  note: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny, 'prose'),
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  action: {
    minHeight: 38,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surfaceHigh,
  },
  actionPrimary: {
    borderColor: color.needsYou,
    backgroundColor: color.needsYou,
  },
  actionDanger: {
    borderColor: color.danger,
    backgroundColor: 'transparent',
  },
  actionPressed: {
    backgroundColor: color.surfacePressed,
  },
  actionDisabled: {
    opacity: 0.5,
  },
  actionLabel: {
    ...sans(600),
    color: color.text,
    fontSize: font.small,
  },
  actionPrimaryLabel: {
    color: color.onAccent,
  },
  actionDangerLabel: {
    color: color.danger,
  },
  error: {
    ...sans(400),
    color: color.danger,
    fontSize: font.tiny,
  },
})
