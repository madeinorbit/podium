import type { PendingInteractionAction, PendingInteractionCard } from '@podium/client-core/values'
import type { SessionId } from '@podium/model'
import { observer } from 'mobx-react-lite'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useTrpc } from '../client/hooks'
import { usePoolInteractionCards } from '../client/use-pool-notices'
import { color, font, leading, sans, space } from '../theme/theme'
import { decisionTile } from './decision-tile'
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
export function PendingInteractionBand({ sessionId }: { sessionId: SessionId }) {
  const cards = usePoolInteractionCards(sessionId)
  return <PendingInteractionBandBody cards={cards} />
}

const PendingInteractionBandBody = observer(function PendingInteractionBandBody({
  cards,
}: {
  cards: readonly PendingInteractionCard[]
}) {
  const trpc = useTrpc()
  const [sending, setSending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
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
          <Text style={styles.title}>{card.title}</Text>
          <Text style={styles.detail}>{card.detail}</Text>
          {card.note !== undefined ? <Text style={styles.note}>{card.note}</Text> : null}
          {card.actions.length > 0 ? (
            <View style={styles.actions}>
              {card.actions.map((action) => (
                <PressableScale
                  key={action.id}
                  testID={`pending-interaction-action-${action.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={action.label}
                  hitSlop={6}
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
})

const styles = StyleSheet.create({
  layer: { paddingHorizontal: space.lg, paddingVertical: space.sm, gap: space.sm },
  band: { ...decisionTile.card, ...decisionTile.signal },
  title: decisionTile.title,
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
  actions: decisionTile.actions,
  action: decisionTile.button,
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
    ...decisionTile.buttonText,
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
