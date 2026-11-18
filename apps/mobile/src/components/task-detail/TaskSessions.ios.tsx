import { HStack, Image, Text, VStack } from '@expo/ui/swift-ui'
import {
  accessibilityElement,
  accessibilityIdentifier,
  accessibilityLabel,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  layoutPriority,
  lineLimit,
  padding,
} from '@expo/ui/swift-ui/modifiers'
import { issueAgentLabel, modelName } from '@podium/client-core/agent-models'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { readoutModel, sessionTitle } from '@podium/client-core/values'
import { here } from '@podium/client-graph/lookup'
import type { SessionId } from '@podium/model'
import { SESSION_WORD_LABEL } from '@podium/model/browser'
import { useWindowDimensions } from 'react-native'
import { issueObserver as observer } from '../../client/issue-observer'
import { useMobilePool } from '../../client/mobile-pool'
import { useContentVisible } from '../../lib/visible-content'
import { color } from '../../theme/theme'
import { deckWordColor } from '../deck-colors'
import { listRowPress } from '../list-row-press.ios'
import { workingWordGlint } from '../working-word-glint.ios'
import { DetailGroup } from './DetailList'
import { detailRowInsets, useDetailSeparator } from './detail-row-geometry'
import type { TaskSessionsProps } from './TaskSessions'

export const TaskSessions = observer(function TaskSessions({
  issue,
  sessions,
  onOpenSession,
}: TaskSessionsProps) {
  if (sessions.length === 0) return null
  return (
    <DetailGroup label="Active sessions" count={String(sessions.length)} testID="task-sessions">
      {sessions.map((session) => (
        <TaskSessionRow
          key={session.sessionId}
          sessionId={session.sessionId}
          issue={issue}
          onOpenSession={onOpenSession}
        />
      ))}
    </DetailGroup>
  )
})

const TaskSessionRow = observer(function TaskSessionRow({
  sessionId,
  issue,
  onOpenSession,
}: {
  sessionId: SessionId
  issue: IssueViewModel
  onOpenSession: (id: SessionId) => void
}) {
  const pool = useMobilePool()
  const visible = useContentVisible()
  const { fontScale } = useWindowDimensions()
  const separator = useDetailSeparator()
  const session = here(pool?.model('session', sessionId))
  if (!session) return null
  const view = here(session.row) as unknown as SessionView | undefined
  if (!view) return null
  const name = sessionTitle(view)
  const role = session.sessionId === issue.coordinatorSessionId ? 'Coordinator' : 'Agent'
  const agent = `${issueAgentLabel(session.agentKind)} · ${role}`
  const model = modelName(session.agentKind, readoutModel(view))
  const word = session.word
  return (
    <HStack
      alignment="center"
      spacing={12}
      modifiers={[
        padding({ vertical: 12 }),
        frame({ minHeight: 44, maxWidth: Infinity, alignment: 'leading' }),
        accessibilityElement('ignore'),
        accessibilityLabel(`${name}, ${agent}, ${model} · ${SESSION_WORD_LABEL[word]}`),
        accessibilityIdentifier('issue-active-session'),
        listRowPress(() => onOpenSession(sessionId)),
        // After the press Button, or the List never sees the row's insets.
        detailRowInsets,
        separator,
      ]}
    >
      {/* The deck's SF ring/dot and native working-word glint, on the same clock. */}
      <Image
        systemName={
          word === 'working' || word === 'idle'
            ? 'circle'
            : word === 'done'
              ? 'checkmark'
              : 'circle.fill'
        }
        size={8}
        color={deckWordColor(word)}
        modifiers={[frame({ width: 20, height: Math.round(20 * Math.max(1, fontScale)) })]}
      />
      <VStack
        alignment="leading"
        spacing={4}
        modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}
      >
        <Text modifiers={[font({ textStyle: 'body' }), foregroundStyle(color.text), ...intrinsic]}>
          {name}
        </Text>
        <HStack spacing={0} modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}>
          <Text
            modifiers={[
              ...meta(deckWordColor(word)),
              ...(word === 'working'
                ? [workingWordGlint(sessionId, visible, SESSION_WORD_LABEL[word])]
                : []),
              fixedSize({ horizontal: true, vertical: false }),
              layoutPriority(1),
            ]}
          >
            {SESSION_WORD_LABEL[word]}
          </Text>
          <Text modifiers={[...meta(color.textDim), ...intrinsic, layoutPriority(-1)]}>
            {` · ${model === 'Auto' ? '' : `${model} · `}${role}`}
          </Text>
        </HStack>
      </VStack>
      {fontScale <= 1.35 ? (
        <Image systemName="chevron.right" size={12} color={color.textFaint} />
      ) : null}
    </HStack>
  )
})

const intrinsic = [
  fixedSize({ horizontal: false, vertical: true }),
  frame({ maxWidth: Infinity, alignment: 'leading' }),
]
// SwiftUI keeps the first foreground style, so each text gets exactly one ink.
const meta = (ink: string) => [font({ textStyle: 'footnote' }), foregroundStyle(ink), lineLimit(1)]
