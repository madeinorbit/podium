import { relativeTime, withoutShells } from '@podium/client-core/focus'
import {
  groupRelations,
  operationalState,
  presenceNote,
  sessionNeedsHuman,
  sessionTitle,
  subIssuesOf,
} from '@podium/client-core/viewmodels'
import { ISSUE_STAGES, type IssueWire, type SessionMeta } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { useRouter } from 'expo-router'
import { Check, ChevronDown, ChevronRight } from 'lucide-react-native'
import { useMemo, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useMobileStore } from '../client/hooks'
import { FLOW_HEX, issueColorHex } from '../theme/issueColors'
import { alpha } from '../theme/mix'
import { STAGE_LABEL } from '../theme/stage'
import {
  color,
  font,
  leading,
  mono,
  monoLabel,
  radius,
  sans,
  space,
  tracking,
} from '../theme/theme'
import { ActionSheet } from './ActionSheet'
import { BottomSheet } from './BottomSheet'
import { Composer } from './Composer'
import { Icon } from './Icon'
import { IdSquare } from './IdSquare'
import { PressableScale } from './PressableScale'
import { kindTone } from './spine'

/**
 * THE TASK INSPECTOR — one sheet, two detents [POD-592, POD-724].
 *
 * Medium is the peek: identity, the decision band, and the beginning of the
 * scroll. Large is the whole inspector plus the comment composer.
 *
 * POD-724 made it the ONLY task-reveal surface on the phone. There were two:
 * this one, and a `TaskPeekSheet` that opened from the session header, from
 * POD-refs in chat and from the work list — a fixed-height card with
 * `animationType="slide"`, no drag, no detents, and its own subset of the same
 * facts. So "peek at a task" meant a sheet you could pull on when you arrived
 * from the deck and a sheet that ignored your finger when you arrived from the
 * transcript, and the two disagreed about what a task even shows. One object
 * now, on the shared {@link BottomSheet}, reached from everywhere.
 *
 * THE SCROLL IS LOCKED AT MEDIUM (the sheet primitive enforces it): dragging
 * content upward promotes the sheet first, and only then does the scroll take
 * over. That is the standard iOS rule and the thing that makes a two-detent
 * sheet feel like one surface rather than a window with a list glued inside it.
 */
export function TaskSheet({
  issue,
  issues,
  sessions,
  onClose,
  onOpenSession,
  onToggleTodo,
  onOpenIssue,
}: {
  issue: IssueWire | null
  issues: readonly IssueWire[]
  sessions: readonly SessionMeta[]
  onClose: () => void
  onOpenSession: (session: SessionMeta) => void
  /**
   * Check an agent's plan item off from inside the sheet. Supplied wherever the
   * caller holds the live issue row, so the checkbox updates in the OPEN sheet
   * instead of waiting to be reopened — the plan bridge is the one thing an
   * operator reaches for mid-transcript.
   */
  onToggleTodo?: (index1: number, done: boolean) => void
  /** Retarget the sheet at another task (a subtask row). Absent = navigate. */
  onOpenIssue?: (issue: IssueWire) => void
}) {
  const store = useMobileStore()
  const router = useRouter()
  const hex = issue ? (issueColorHex(issue.color) ?? FLOW_HEX) : FLOW_HEX

  const post = (body: string) => {
    if (!issue) return
    void store.trpc.issues.addComment
      .mutate({ id: issue.id, author: 'mobile', body })
      .catch(() => {})
  }

  return (
    <BottomSheet
      visible={issue !== null}
      onClose={onClose}
      mode="detented"
      accent={hex}
      testID="task-sheet"
      head={
        issue ? (
          <SheetHead
            issue={issue}
            issues={issues}
            sessions={sessions}
            hex={hex}
            onOpenSession={onOpenSession}
          />
        ) : null
      }
      footer={issue ? <Composer placeholder="Comment on this task…" onSend={post} /> : null}
      footerRule={false}
    >
      {issue ? (
        <SheetBody
          issue={issue}
          issues={issues}
          sessions={sessions}
          onOpenSession={onOpenSession}
          {...(onToggleTodo ? { onToggleTodo } : {})}
          onOpenIssue={(target) => {
            if (onOpenIssue) return onOpenIssue(target)
            onClose()
            router.push(`/issue/${encodeURIComponent(target.id)}`)
          }}
        />
      ) : null}
    </BottomSheet>
  )
}

/**
 * The fixed head — bounded BY CONSTRUCTION: a ref line, a title, one control
 * row and a one-line decision band. Nothing data-sized is allowed above the
 * scroll; the desktop dock became unscrollable the moment a stack of offer
 * cards was let into its fixed region.
 */
function SheetHead({
  issue,
  sessions,
  issues,
  hex,
  onOpenSession,
}: {
  issue: IssueWire
  sessions: readonly SessionMeta[]
  issues: readonly IssueWire[]
  hex: string
  onOpenSession: (session: SessionMeta) => void
}) {
  const store = useMobileStore()
  const [stageOpen, setStageOpen] = useState(false)
  const byId = useMemo(() => new Map(issues.map((i) => [i.id, i])), [issues])
  const mine = useMemo(
    () => withoutShells([...sessions]).filter((s) => s.issueId === issue.id && !s.archived),
    [sessions, issue.id],
  )
  const asking = mine.filter(sessionNeedsHuman)
  const op = operationalState(issue, mine, byId)
  const presence = presenceNote(issue, mine, byId)

  return (
    <View style={styles.head}>
      <View style={styles.identRow}>
        <IdSquare
          issue={issue}
          state={issue.needsHuman ? 'waiting' : mine.length > 0 ? 'working' : 'queued'}
          size={22}
        />
        <Text style={[styles.chip, styles.chipRef]}>{issueDisplayRef(issue)}</Text>
        <Text
          style={[
            styles.chip,
            {
              borderColor: alpha(hex, 0.45),
              color: alpha(hex, 0.95),
              backgroundColor: alpha(hex, 0.12),
            },
          ]}
        >
          {issue.stage.replace('_', ' ')}
        </Text>
        <View style={styles.flex} />
        <Text style={styles.chip}>P{issue.priority}</Text>
      </View>

      <Text numberOfLines={2} style={styles.title}>
        {issue.title}
      </Text>

      <View style={styles.decide}>
        <PressableScale
          style={styles.stagePill}
          accessibilityRole="button"
          accessibilityLabel="Change stage"
          onPress={() => setStageOpen(true)}
        >
          <Text style={styles.stagePillText}>{STAGE_LABEL[issue.stage]}</Text>
          <Icon as={ChevronDown} size={11} color={color.text} />
        </PressableScale>
        {/* `Answer` is a ROUTE, not a second answering surface: the agent that
            stopped already has its offer card and its buttons in the transcript.
            With nobody on the task at all, the same slot starts one. */}
        <PressableScale
          style={styles.primary}
          accessibilityRole="button"
          accessibilityLabel={asking.length > 0 ? 'Answer' : 'Run now'}
          onPress={() => {
            const target = asking[0]
            if (target) return onOpenSession(target)
            void store.trpc.issues.start.mutate({ id: issue.id }).catch(() => {})
          }}
        >
          <Text style={styles.primaryText}>{asking.length > 0 ? 'Answer' : 'Run now'}</Text>
        </PressableScale>
      </View>

      {asking.length > 0 ? (
        <View style={styles.asking}>
          <Text style={styles.askingText}>
            <Text style={styles.askingLead}>
              {asking.length} agent{asking.length === 1 ? '' : 's'}{' '}
              {asking.length === 1 ? 'is' : 'are'} asking.
            </Text>{' '}
            {asking[0]?.offer?.message?.trim() || 'Open the transcript to answer.'}
          </Text>
        </View>
      ) : op.state === 'waiting' ? (
        <View style={[styles.asking, styles.blocked]}>
          <Text style={[styles.askingText, styles.blockedText]}>{op.label}</Text>
        </View>
      ) : presence ? (
        <Text style={styles.presence}>{presence.text}</Text>
      ) : null}

      <ActionSheet
        visible={stageOpen}
        title="Stage"
        onClose={() => setStageOpen(false)}
        actions={ISSUE_STAGES.map((stage) => ({
          label: STAGE_LABEL[stage],
          selected: stage === issue.stage,
          disabled: stage === issue.stage,
          onPress: () => {
            void store.trpc.issues.update.mutate({ id: issue.id, patch: { stage } }).catch(() => {})
          },
        }))}
      />
    </View>
  )
}

function SheetBody({
  issue,
  issues,
  sessions,
  onOpenSession,
  onToggleTodo,
  onOpenIssue,
}: {
  issue: IssueWire
  issues: readonly IssueWire[]
  sessions: readonly SessionMeta[]
  onOpenSession: (s: SessionMeta) => void
  onToggleTodo?: (index1: number, done: boolean) => void
  onOpenIssue: (issue: IssueWire) => void
}) {
  const children = useMemo(() => subIssuesOf([...issues], issue.id), [issues, issue.id])
  const relations = useMemo(() => groupRelations(issue), [issue])
  const byId = useMemo(() => new Map(issues.map((i) => [i.id, i])), [issues])
  const mine = useMemo(
    () =>
      withoutShells([...sessions])
        .filter((s) => s.issueId === issue.id && !s.archived)
        .sort((a, b) => {
          const an = sessionNeedsHuman(a)
          const bn = sessionNeedsHuman(b)
          if (an !== bn) return an ? -1 : 1
          return b.lastActiveAt.localeCompare(a.lastActiveAt)
        }),
    [sessions, issue.id],
  )
  const todos = issue.panel?.todos ?? []
  const done = todos.filter((t) => t.done).length
  const artifacts = issue.panel?.artifacts ?? []
  const git = issue.gitState

  return (
    <View style={styles.body}>
      {/* The task in the author's own words, UNCAPPED — it sits in the scroll
          precisely so it can be. */}
      {issue.description.trim() ? <Text style={styles.prose}>{issue.description}</Text> : null}

      <Part
        title="Current update"
        meta={issue.notesUpdatedAt ? relativeTime(issue.notesUpdatedAt, Date.now()) : undefined}
      >
        <Text style={[styles.proseTight, issue.activityNotes ? null : styles.proseEmpty]}>
          {issue.activityNotes || 'No status posted yet.'}
        </Text>
      </Part>

      {todos.length > 0 ? (
        <Part title="Evidence & checks" meta={`${done} / ${todos.length}`}>
          <View style={styles.meterTrack}>
            <View style={[styles.meterFill, { width: `${(done / todos.length) * 100}%` }]} />
          </View>
          {todos.map((todo, index) => (
            <PressableScale
              // biome-ignore lint/suspicious/noArrayIndexKey: issue todos are positional; the mutation API addresses this exact 1-based index.
              key={`${index}:${todo.text}`}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: todo.done, disabled: !onToggleTodo }}
              accessibilityLabel={todo.text}
              disabled={!onToggleTodo}
              scaleTo={0.99}
              onPress={() => onToggleTodo?.(index + 1, !todo.done)}
              style={({ pressed }) => [styles.todo, pressed && styles.rowPressed]}
            >
              <View style={[styles.todoBox, todo.done ? styles.todoBoxDone : null]}>
                {todo.done ? <Icon as={Check} size={9} color="#fff" /> : null}
              </View>
              <Text style={[styles.todoText, todo.done ? styles.todoTextDone : null]}>
                {todo.text}
              </Text>
            </PressableScale>
          ))}
        </Part>
      ) : null}

      {artifacts.length > 0 ? (
        <Part title="Artifacts" meta={String(artifacts.length)}>
          {artifacts.map((artifact) => (
            <View key={artifact.path} style={styles.row}>
              <Text numberOfLines={1} style={styles.rowTitle}>
                {artifact.title || artifact.path.split('/').pop()}
              </Text>
            </View>
          ))}
        </Part>
      ) : null}

      {children.length > 0 ? (
        <Part
          title="Subtasks"
          meta={`${children.filter((c) => c.stage === 'done').length} / ${children.length}`}
        >
          {children.map((child) => (
            <PressableScale
              key={child.id}
              accessibilityRole="button"
              accessibilityLabel={`${issueDisplayRef(child)} ${child.title}`}
              onPress={() => onOpenIssue(child)}
              scaleTo={0.99}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <Text style={styles.rowRef}>{issueDisplayRef(child)}</Text>
              <Text numberOfLines={1} style={styles.rowTitle}>
                {child.title}
              </Text>
              <Icon as={ChevronRight} size={14} color={color.textMicro} />
            </PressableScale>
          ))}
        </Part>
      ) : null}

      {mine.length > 0 ? (
        <Part title="Agents & sessions" meta={String(mine.length)}>
          {mine.map((session) => {
            const tone = kindTone(session.agentKind)
            return (
              <PressableScale
                key={session.sessionId}
                accessibilityRole="button"
                accessibilityLabel={`Open ${sessionTitle(session)}`}
                onPress={() => onOpenSession(session)}
                scaleTo={0.99}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              >
                <View style={[styles.kind, { backgroundColor: tone.bg }]}>
                  <Text style={[styles.kindCh, { color: tone.fg }]}>{tone.ch}</Text>
                </View>
                <Text numberOfLines={1} style={styles.rowTitle}>
                  {sessionTitle(session)}
                </Text>
                {sessionNeedsHuman(session) ? <View style={styles.dot} /> : null}
                <Text style={styles.rowStamp}>
                  {relativeTime(session.lastActiveAt, Date.now())}
                </Text>
              </PressableScale>
            )
          })}
        </Part>
      ) : null}

      {relations.length > 0 ? (
        <Part title="Relations" meta={String(relations.length)}>
          {relations.map((rel) => (
            <View key={rel.section} style={styles.row}>
              <Text style={styles.rowRef}>{rel.section}</Text>
              <Text numberOfLines={1} style={styles.rowTitle}>
                {rel.entries
                  .map((entry) => {
                    const target = byId.get(entry.id)
                    return target ? issueDisplayRef(target) : entry.id.slice(0, 8)
                  })
                  .join(', ')}
              </Text>
            </View>
          ))}
        </Part>
      ) : null}

      {issue.branch ? (
        <Part title="Branch & worktree">
          <Text style={styles.branch}>{issue.branch}</Text>
          <Text style={styles.gitLine}>
            {git?.ahead ? `↑${git.ahead} · ` : ''}
            {git?.dirtyFiles ? `${git.dirtyFiles} dirty` : 'clean'}
            {issue.worktreePath
              ? ` · ${issue.worktreePath.replace(/^.*\/\.worktrees\//, '…/')}`
              : ''}
          </Text>
        </Part>
      ) : null}
    </View>
  )
}

function Part({
  title,
  meta,
  children,
}: {
  title: string
  meta?: string
  children: React.ReactNode
}) {
  return (
    <View style={styles.part}>
      <View style={styles.partHdr}>
        <Text style={styles.partTitle}>{title}</Text>
        <View style={styles.rule} />
        {meta ? <Text style={styles.partMeta}>{meta}</Text> : null}
      </View>
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },

  head: {
    paddingHorizontal: 18,
    paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: alpha(color.border, 0.7),
  },
  identRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: 8 },
  chip: {
    ...mono(400),
    fontSize: font.micro,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    color: color.textDim,
    backgroundColor: color.surface,
    overflow: 'hidden',
  },
  chipRef: { ...mono(600), color: color.body },
  title: {
    ...sans(600),
    fontSize: 19,
    lineHeight: 24,
    color: color.text,
    letterSpacing: -0.3,
  },
  decide: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.md },
  stagePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 36,
    paddingHorizontal: 11,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  stagePillText: { ...sans(500), fontSize: font.tiny, color: color.text },
  primary: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 36,
    borderRadius: radius.md,
    backgroundColor: color.accent,
  },
  primaryText: { ...sans(600), fontSize: font.small, color: color.onAccent },
  asking: {
    marginTop: 11,
    padding: 10,
    borderRadius: radius.md,
    backgroundColor: color.accentSoft,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.accentBorder,
  },
  askingText: { ...sans(400), fontSize: font.tiny, lineHeight: 18, color: color.accentTint },
  askingLead: { ...sans(600), color: color.accentTint },
  blocked: { backgroundColor: color.dangerSoft, borderColor: alpha(color.danger, 0.4) },
  blockedText: { color: '#f0a0a6' },
  presence: { ...mono(400), fontSize: font.micro, color: color.textMicro, marginTop: 10 },

  body: { paddingHorizontal: 18, paddingTop: space.md },
  prose: {
    ...sans(400),
    fontSize: font.small,
    lineHeight: leading(15, 'prose'),
    letterSpacing: tracking[15],
    color: color.textDim,
    marginBottom: 18,
  },
  proseTight: { ...sans(400), fontSize: font.tiny, lineHeight: 19, color: alpha(color.body, 0.85) },
  proseEmpty: { color: color.textFaint, fontStyle: 'italic' },

  part: { marginBottom: 20 },
  partHdr: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: space.sm },
  partTitle: { ...monoLabel(font.micro), color: color.label },
  partMeta: { ...mono(400), fontSize: font.micro, color: color.textMicro },
  rule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: color.hairline },

  meterTrack: {
    height: 3,
    marginBottom: space.sm,
    borderRadius: radius.full,
    overflow: 'hidden',
    backgroundColor: alpha(color.border, 0.7),
  },
  meterFill: { height: '100%', backgroundColor: color.working },

  todo: {
    flexDirection: 'row',
    gap: 9,
    paddingVertical: 7,
    minHeight: 34,
    borderRadius: radius.sm,
  },
  todoBox: {
    width: 17,
    height: 17,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: color.borderStrong,
    marginTop: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  todoBoxDone: { backgroundColor: color.working, borderColor: color.working },
  todoText: { ...sans(400), flex: 1, fontSize: font.tiny, lineHeight: 19, color: color.textDim },
  todoTextDone: { color: color.textMicro, textDecorationLine: 'line-through' },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 44,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: alpha(color.hairline, 0.55),
  },
  rowPressed: { backgroundColor: color.surfacePressed },
  rowRef: { ...mono(400), fontSize: font.micro, color: color.textMicro, minWidth: 52 },
  rowTitle: { ...sans(400), flex: 1, fontSize: font.tiny, color: color.body },
  rowStamp: { ...mono(400), fontSize: font.micro, color: color.textMicro },
  kind: {
    width: 20,
    height: 20,
    borderRadius: radius.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  kindCh: { ...mono(600), fontSize: 9 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: color.accent },

  branch: { ...mono(400), fontSize: font.micro, color: color.accentTint },
  gitLine: { ...mono(400), fontSize: font.micro, color: color.textFaint, marginTop: 4 },
})
