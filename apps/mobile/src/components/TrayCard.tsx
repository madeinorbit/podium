import { relativeTime } from '@podium/client-core/focus'
import type { IssuePanelArtifact, IssueWire, SessionMeta, SessionOffer } from '@podium/protocol'
import { useState } from 'react'
import { Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import type { TrayItem } from '../lib/derive-tray'
import { resolveOfferArtifacts } from '../lib/offer-artifacts'
import { effectiveIssueColorHex, FLOW_SLATE, flow, issueColorHex } from '../theme/issueColors'
import { alpha } from '../theme/mix'
import { color, font, mono, radius, sans, space } from '../theme/theme'
import { IdSquare } from './IdSquare'

/** Compose an input-action's prompt with the collected feedback (web parity). */
export const composeOfferPrompt = (prompt: string, feedback: string): string =>
  `${prompt}\n\n${feedback.trim()}`

const MAX_THUMBS = 3

export interface TrayCardActions {
  /** Send an offer action's prompt to its session as a user turn (the server
   *  then clears the offer — one item, one fate). */
  onOfferAction: (session: SessionMeta, prompt: string) => void
  onOpenSession: (session: SessionMeta) => void
  onOpenIssue: (issue: IssueWire) => void
  /** Answer chip on an issue question (issues.answerHumanQuestion path is the
   *  session composer for now — mobile routes the chip text as a session turn
   *  when an asking session exists, else opens the issue). */
  onResolve: (issue: IssueWire) => void
  onArchive: (issue: IssueWire) => void
  /** Open the artifact lightbox / viewer for a thumb. */
  onOpenArtifact: (issue: IssueWire, artifact: IssuePanelArtifact) => void
}

function agentName(session: SessionMeta | undefined): string | null {
  if (!session) return null
  return session.name ?? null
}

/** The offer/question/review/finished card [POD-131] — POD-113 grammar in the
 *  Superade palette: issue colour = identity tint (never state), yellow
 *  ago-stamp, primary action as a yellow button. */
export function TrayCard({
  item,
  issues,
  httpOrigin,
  actions,
  now,
}: {
  item: TrayItem
  issues: IssueWire[]
  httpOrigin: string
  actions: TrayCardActions
  now: number
}) {
  const issue = item.issue
  const [pending, setPending] = useState<number | null>(null)
  const [feedback, setFeedback] = useState('')
  const flowHex = effectiveIssueColorHex(issue, (id) => issues.find((i) => i.id === id))
  const hex = flowHex ?? FLOW_SLATE
  const session =
    item.kind === 'offer'
      ? item.session
      : (issue.sessions ?? []).find(
          (s) => !s.archived && s.agentKind !== 'shell' && s.headless !== true,
        )
  const ago = relativeTime(item.since, now)
  const squareHex = issueColorHex(issue.color)

  const header = (
    <View style={styles.top}>
      <IdSquare
        issue={issue}
        state={issue.needsHuman || item.kind === 'offer' ? 'waiting' : 'working'}
        size={18}
        ringColor={flow.rowBg(hex)}
      />
      <Text style={styles.ref}>{`POD-${issue.seq}`}</Text>
      <Text
        style={[styles.issueTitle, squareHex ? { color: flow.muted(hex) } : null]}
        numberOfLines={1}
      >
        {issue.title}
      </Text>
      {agentName(session) ? (
        <Text style={styles.agent} numberOfLines={1}>
          <Text style={styles.agentGlyph}>◆ </Text>
          {agentName(session)}
        </Text>
      ) : null}
      <Text style={styles.ago}>{ago}</Text>
    </View>
  )

  const sessionLink = session ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open session"
      onPress={() => actions.onOpenSession(session)}
      hitSlop={8}
      style={styles.sessionLink}
    >
      <Text style={styles.sessionLinkText}>session →</Text>
    </Pressable>
  ) : null

  if (item.kind === 'offer') {
    const offer: SessionOffer = item.offer
    const [headline, ...rest] = offer.message.split('\n')
    const body = rest.join('\n').trim()
    const artifacts = resolveOfferArtifacts({
      offer,
      issue,
      ...(item.session.lastInputAt ? { lastInputAt: item.session.lastInputAt } : {}),
    })
    const shown = artifacts.slice(0, MAX_THUMBS)
    const extra = artifacts.length - shown.length
    const pendingAction = pending === null ? undefined : offer.actions[pending]
    return (
      <View
        style={[styles.card, { backgroundColor: flow.rowBg(hex), borderColor: alpha(hex, 0.4) }]}
      >
        {header}
        <Text style={styles.headline}>{headline}</Text>
        {body ? (
          <Text style={styles.body} numberOfLines={2}>
            {body}
          </Text>
        ) : null}
        {shown.length > 0 ? (
          <View style={styles.shots}>
            {shown.map((a) => (
              <Pressable
                key={a.artifactId ?? a.path}
                accessibilityRole="imagebutton"
                accessibilityLabel={a.title ?? a.path}
                onPress={() => actions.onOpenArtifact(issue, a)}
                style={styles.shot}
              >
                {a.artifactId ? (
                  <Image
                    source={{
                      uri: `${httpOrigin}/files/artifact/${encodeURIComponent(issue.id)}/${encodeURIComponent(a.artifactId)}/${a.entry ?? ''}`,
                    }}
                    style={styles.shotImg}
                    resizeMode="cover"
                  />
                ) : (
                  <Text style={styles.shotLabel} numberOfLines={1}>
                    {a.title ?? a.path.split('/').pop()}
                  </Text>
                )}
              </Pressable>
            ))}
            {extra > 0 ? (
              <View style={[styles.shot, styles.shotMore]}>
                <Text style={styles.shotLabel}>+{extra}</Text>
              </View>
            ) : null}
          </View>
        ) : null}
        {pendingAction ? (
          <View style={styles.inputWrap}>
            <TextInput
              accessibilityLabel={`${pendingAction.label} feedback`}
              style={styles.input}
              value={feedback}
              onChangeText={setFeedback}
              placeholder={`${pendingAction.label} — add your feedback…`}
              placeholderTextColor={color.textFaint}
              multiline
              autoFocus
            />
            <View style={styles.actRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={pendingAction.label}
                disabled={!feedback.trim()}
                style={[styles.btn, styles.btnPrimary, !feedback.trim() && styles.btnDisabled]}
                onPress={() => {
                  actions.onOfferAction(
                    item.session,
                    composeOfferPrompt(pendingAction.prompt, feedback),
                  )
                  setPending(null)
                  setFeedback('')
                }}
              >
                <Text style={styles.btnPrimaryText}>{pendingAction.label}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel"
                onPress={() => {
                  setPending(null)
                  setFeedback('')
                }}
                hitSlop={8}
              >
                <Text style={styles.cancel}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.actRow}>
            {offer.actions.map((action, ai) => (
              <Pressable
                key={`${action.label}:${action.prompt}`}
                accessibilityRole="button"
                accessibilityLabel={action.label}
                style={[styles.btn, ai === 0 ? styles.btnPrimary : styles.btnSecondary]}
                onPress={() => {
                  if (action.input === true) setPending(ai)
                  else actions.onOfferAction(item.session, action.prompt)
                }}
              >
                <Text style={ai === 0 ? styles.btnPrimaryText : styles.btnSecondaryText}>
                  {action.label}
                </Text>
              </Pressable>
            ))}
            {sessionLink}
          </View>
        )}
      </View>
    )
  }

  if (item.kind === 'question') {
    const options = issue.humanQuestionOptions ?? []
    return (
      <View
        style={[
          styles.card,
          { backgroundColor: flow.rowBg(hex), borderColor: alpha(hex, 0.3), opacity: 0.96 },
        ]}
      >
        {header}
        <Text style={styles.headline}>{item.text}</Text>
        {options.map((option) => (
          <Pressable
            key={option}
            accessibilityRole="button"
            accessibilityLabel={option}
            style={styles.option}
            onPress={() =>
              session ? actions.onOfferAction(session, option) : actions.onOpenIssue(issue)
            }
          >
            <Text style={styles.optionText}>{option}</Text>
          </Pressable>
        ))}
        <View style={styles.actRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Resolve question"
            onPress={() => actions.onResolve(issue)}
            hitSlop={8}
          >
            <Text style={styles.cancel}>resolve ✓</Text>
          </Pressable>
          {sessionLink}
        </View>
      </View>
    )
  }

  if (item.kind === 'review') {
    return (
      <View
        style={[styles.card, { backgroundColor: flow.rowBg(hex), borderColor: alpha(hex, 0.3) }]}
      >
        {header}
        <Text style={styles.headline}>Ready for review</Text>
        <View style={styles.actRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open task"
            style={[styles.btn, styles.btnPrimary]}
            onPress={() => actions.onOpenIssue(issue)}
          >
            <Text style={styles.btnPrimaryText}>Review</Text>
          </Pressable>
          {sessionLink}
        </View>
      </View>
    )
  }

  // finished
  return (
    <View style={[styles.card, styles.cardDone, { backgroundColor: flow.rowBg(hex) }]}>
      <View style={styles.top}>
        <IdSquare issue={issue} state="done" size={18} ringColor={flow.rowBg(hex)} />
        <Text style={styles.ref}>{`POD-${issue.seq}`}</Text>
        <Text style={styles.doneText} numberOfLines={1}>
          {issue.closedReason ?? 'done'}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Archive task"
          style={[styles.btn, styles.btnSecondary, styles.btnCompact]}
          onPress={() => actions.onArchive(issue)}
        >
          <Text style={styles.btnSecondaryText}>Archive ✓</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 9,
    gap: 7,
  },
  cardDone: {
    opacity: 0.8,
    borderColor: color.hairline,
    paddingVertical: 7,
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    minWidth: 0,
  },
  ref: {
    ...mono(500),
    color: color.textDim,
    fontSize: font.micro,
  },
  issueTitle: {
    flex: 1,
    minWidth: 0,
    color: color.textDim,
    fontSize: font.tiny + 0.5,
  },
  agent: {
    color: color.textFaint,
    fontSize: font.micro + 0.5,
    maxWidth: 90,
  },
  agentGlyph: {
    color: color.claude,
  },
  ago: {
    ...mono(500),
    color: color.accent,
    fontSize: font.micro,
  },
  headline: {
    ...sans(600),
    color: color.text,
    fontSize: font.body,
    lineHeight: 18,
  },
  body: {
    color: color.textDim,
    fontSize: font.small - 0.5,
    lineHeight: 16,
  },
  shots: {
    flexDirection: 'row',
    gap: 6,
  },
  shot: {
    width: 70,
    height: 44,
    borderRadius: radius.xs,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surfaceHigh,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shotImg: {
    width: '100%',
    height: '100%',
  },
  shotMore: {
    width: 34,
  },
  shotLabel: {
    ...mono(400),
    color: color.textFaint,
    fontSize: 8,
    paddingHorizontal: 3,
  },
  actRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    flexWrap: 'wrap',
  },
  btn: {
    minHeight: 30,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnCompact: {
    minHeight: 24,
    paddingHorizontal: 9,
    marginLeft: 'auto',
  },
  btnPrimary: {
    backgroundColor: color.accent,
  },
  btnPrimaryText: {
    ...sans(600),
    color: color.onAccent,
    fontSize: font.small - 0.5,
  },
  btnSecondary: {
    backgroundColor: color.elevated,
    borderWidth: 1,
    borderColor: color.borderStrong,
  },
  btnSecondaryText: {
    ...sans(500),
    color: color.body,
    fontSize: font.small - 0.5,
  },
  btnDisabled: {
    opacity: 0.5,
  },
  sessionLink: {
    marginLeft: 'auto',
  },
  sessionLinkText: {
    ...mono(400),
    color: color.textDim,
    fontSize: font.tiny,
  },
  option: {
    borderWidth: 1,
    borderColor: color.borderStrong,
    backgroundColor: color.elevated,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 7,
  },
  optionText: {
    ...sans(500),
    color: color.body,
    fontSize: font.small,
  },
  inputWrap: {
    gap: 7,
  },
  input: {
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderRadius: radius.sm,
    color: color.text,
    fontSize: font.small,
    paddingHorizontal: space.sm + 2,
    paddingVertical: 6,
    minHeight: 52,
    textAlignVertical: 'top',
  },
  cancel: {
    ...mono(400),
    color: color.textDim,
    fontSize: font.tiny,
  },
  doneText: {
    ...mono(400),
    flex: 1,
    minWidth: 0,
    color: color.textDim,
    fontSize: font.tiny,
  },
})
