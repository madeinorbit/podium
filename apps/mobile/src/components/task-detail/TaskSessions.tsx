import { issueAgentLabel, modelName } from '@podium/client-core/agent-models'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { readoutModel, sessionTitle } from '@podium/client-core/values'
import { here } from '@podium/client-graph/lookup'
import type { SessionId } from '@podium/model'
import { SESSION_WORD_LABEL } from '@podium/model/browser'
import { StyleSheet, View } from 'react-native'
import { issueObserver as observer } from '../../client/issue-observer'
import { useMobilePool } from '../../client/mobile-pool'
import { color, font, sans } from '../../theme/theme'
import { deckWordColor } from '../deck-colors'
import { Icon } from '../Icon'
import { ChevronRight } from '../icons'
import { PressableScale } from '../PressableScale'
import { WorkingWord } from '../WorkingWord'
import { DetailGroup } from './DetailList'
import { DetailText as Text } from './DetailText'
import { useDetailLayout } from './detail-type'

export interface TaskSessionsProps {
  issue: IssueViewModel
  /** The shared page view's active roster, in its contract order. */
  sessions: readonly SessionView[]
  onOpenSession: (id: SessionId) => void
}

export const TaskSessions = observer(function TaskSessions({
  issue,
  sessions,
  onOpenSession,
}: TaskSessionsProps) {
  if (sessions.length === 0) return null
  return (
    <DetailGroup label="Active sessions" count={String(sessions.length)} testID="task-sessions">
      {sessions.map((session, index) => (
        <TaskSessionRow
          key={session.sessionId}
          sessionId={session.sessionId}
          issue={issue}
          first={index === 0}
          onOpenSession={onOpenSession}
        />
      ))}
    </DetailGroup>
  )
})

const TaskSessionRow = observer(function TaskSessionRow({
  sessionId,
  issue,
  first,
  onOpenSession,
}: {
  sessionId: SessionId
  issue: IssueViewModel
  first: boolean
  onOpenSession: (id: SessionId) => void
}) {
  const pool = useMobilePool()
  const { accessorySize, accessibility } = useDetailLayout()
  const session = here(pool?.model('session', sessionId))
  if (!session) return null
  const view = here(session.row) as unknown as SessionView | undefined
  if (!view) return null
  const name = sessionTitle(session)
  const role = session.sessionId === issue.coordinatorSessionId ? 'Coordinator' : 'Agent'
  const agent = `${issueAgentLabel(session.agentKind)} · ${role}`
  const model = modelName(session.agentKind, readoutModel(view))
  const word = session.word
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${agent}, ${model} · ${SESSION_WORD_LABEL[word]}`}
      accessibilityHint="Opens the session"
      onPress={() => onOpenSession(sessionId)}
      scaleTo={1}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      {!first ? <View style={styles.separator} /> : null}
      <View style={[styles.glyph, { width: accessorySize(20) }]}>
        <View
          style={[
            styles.dot,
            word === 'working' && styles.ring,
            {
              borderColor: deckWordColor(word),
              backgroundColor: word === 'working' ? 'transparent' : deckWordColor(word),
            },
          ]}
        />
      </View>
      <View style={styles.body}>
        <Text style={styles.name}>{name}</Text>
        <Text style={styles.meta}>{agent}</Text>
        <View style={styles.metaLine}>
          <WorkingWord
            active={word === 'working'}
            seed={sessionId}
            style={[styles.meta, { color: deckWordColor(word) }]}
          >
            {SESSION_WORD_LABEL[word]}
          </WorkingWord>
          <Text style={styles.meta}>· {model}</Text>
        </View>
      </View>
      {!accessibility ? (
        <Icon as={ChevronRight} size={accessorySize(14)} color={color.textFaint} />
      ) : null}
    </PressableScale>
  )
})

const styles = StyleSheet.create({
  row: {
    minHeight: 44,
    padding: 12,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  separator: {
    position: 'absolute',
    top: 0,
    left: 48,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.hairline,
  },
  glyph: { width: 20, minHeight: 20, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  ring: { borderWidth: 1.5 },
  body: { flex: 1, minWidth: 0, gap: 4 },
  name: { ...sans(400), fontSize: font.body, color: color.text },
  meta: { ...sans(400), fontSize: font.tiny, color: color.textDim },
  metaLine: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  pressed: { backgroundColor: color.surfacePressed },
})
