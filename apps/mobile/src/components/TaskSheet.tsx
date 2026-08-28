import { relativeTime, withoutShells } from '@podium/client-core/focus'
import {
  groupRelations,
  operationalState,
  presenceNote,
  sessionNeedsHuman,
  sessionTitle,
  subIssuesOf,
} from '@podium/client-core/viewmodels'
import {
  type IssueCloseReason,
  type IssueWire,
  issueStatusLabel,
  issueStatusMenuEntries,
  issueStatusValueOf,
  parseIssueStatusValue,
  type SessionMeta,
} from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { useRouter } from 'expo-router'
import { ChevronDown, ChevronRight } from 'lucide-react-native'
import { useMemo, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useHttpOrigin, useStoreActions, useTrpc } from '../client/hooks'
import { issueArtifactHref, issueArtifactLabel } from '../lib/issue-artifacts'
import { issueCloseBlockers } from '../lib/issue-close'
import { FLOW_HEX, issueColorHex } from '../theme/issueColors'
import { alpha } from '../theme/mix'
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
import { AgentMark, kindTone, markSize } from './AgentMark'
import { ArtifactViewer } from './ArtifactViewer'
import { BottomSheet } from './BottomSheet'
import { Composer } from './Composer'
import { Icon } from './Icon'
import { IdSquare } from './IdSquare'
import { IssueCloseSheet } from './IssueCloseSheet'
import { PressableScale } from './PressableScale'
import { StageGlyph } from './StageGlyph'

/** The session row's harness chip. Named because the mark is sized from it. */
const SESSION_CHIP = 20

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
  onOpenIssue,
}: {
  issue: IssueWire | null
  issues: readonly IssueWire[]
  sessions: readonly SessionMeta[]
  onClose: () => void
  onOpenSession: (session: SessionMeta) => void
  /** Retarget the sheet at another task (a subtask row). Absent = navigate. */
  onOpenIssue?: (issue: IssueWire) => void
}) {
  const trpc = useTrpc()
  const router = useRouter()
  const hex = issue ? (issueColorHex(issue.color) ?? FLOW_HEX) : FLOW_HEX

  const post = (body: string) => {
    if (!issue) return
    void trpc.issues.addComment.mutate({ id: issue.id, author: 'mobile', body }).catch(() => {})
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
  const trpc = useTrpc()
  const { updateIssue, closeIssue } = useStoreActions()
  const [stageOpen, setStageOpen] = useState(false)
  const [closeReason, setCloseReason] = useState<IssueCloseReason | null>(null)
  const byId = useMemo(() => new Map(issues.map((i) => [i.id, i])), [issues])
  const mine = useMemo(
    () => withoutShells(sessions).filter((s) => s.issueId === issue.id && !s.archived),
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
          <Text style={styles.stagePillText}>{issueStatusLabel(issue)}</Text>
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
            void trpc.issues.start.mutate({ id: issue.id }).catch(() => {})
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

      {/* The deck card gets the SAME status list as everywhere else (POD-1074),
          endings included — marking a task done from the deck is the most
          ordinary thing anyone does here. The terminal picks close with their
          reason rather than parking the row on the done lane with none. */}
      <ActionSheet
        visible={stageOpen}
        title="Status"
        onClose={() => setStageOpen(false)}
        actions={issueStatusMenuEntries().map((entry) => ({
          label: entry.label,
          ...(entry.hint ? { hint: entry.hint } : {}),
          icon: <StageGlyph stage={entry.status} size={15} ground={color.surface} />,
          selected: entry.value === issueStatusValueOf(issue),
          disabled: entry.value === issueStatusValueOf(issue),
          onPress: () => {
            const intent = parseIssueStatusValue(entry.value)
            if (!intent) return
            if (intent.kind === 'stage') {
              void updateIssue(issue.id, { stage: intent.stage }).catch(() => {})
              return
            }
            // The SAME guard the task page and the desktop raise (POD-1129),
            // over the same derivation — and raised only when it has something
            // to say, so a tidy task still closes on the press.
            if (issueCloseBlockers(issue, sessions).length > 0) {
              setCloseReason(intent.reason)
              return
            }
            void closeIssue(issue.id, intent.reason).catch(() => {})
          },
        }))}
      />

      <IssueCloseSheet
        issue={issue}
        sessions={sessions}
        reason={closeReason}
        onConfirm={(reason) => {
          void closeIssue(issue.id, reason).catch(() => {})
        }}
        onClose={() => setCloseReason(null)}
      />
    </View>
  )
}

function SheetBody({
  issue,
  issues,
  sessions,
  onOpenSession,
  onOpenIssue,
}: {
  issue: IssueWire
  issues: readonly IssueWire[]
  sessions: readonly SessionMeta[]
  onOpenSession: (s: SessionMeta) => void
  onOpenIssue: (issue: IssueWire) => void
}) {
  const children = useMemo(() => subIssuesOf(issues, issue.id), [issues, issue.id])
  const relations = useMemo(() => groupRelations(issue), [issue])
  const byId = useMemo(() => new Map(issues.map((i) => [i.id, i])), [issues])
  const mine = useMemo(
    () =>
      withoutShells(sessions)
        .filter((s) => s.issueId === issue.id && !s.archived)
        .sort((a, b) => {
          const an = sessionNeedsHuman(a)
          const bn = sessionNeedsHuman(b)
          if (an !== bn) return an ? -1 : 1
          return b.lastActiveAt.localeCompare(a.lastActiveAt)
        }),
    [sessions, issue.id],
  )
  const httpOrigin = useHttpOrigin()
  const artifacts = issue.panel?.artifacts ?? []
  const [openArtifact, setOpenArtifact] = useState<(typeof artifacts)[number] | null>(null)
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

      {artifacts.length > 0 ? (
        <Part title="Artifacts" meta={String(artifacts.length)}>
          {artifacts.map((artifact) => {
            const url = issueArtifactHref(issue, artifact, httpOrigin)
            const label = issueArtifactLabel(artifact)
            return (
              <PressableScale
                key={`${artifact.addedAt}:${artifact.path}`}
                accessibilityRole={url ? 'button' : undefined}
                accessibilityLabel={url ? `Open ${label}` : label}
                disabled={!url}
                onPress={url ? () => setOpenArtifact(artifact) : undefined}
                scaleTo={0.99}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              >
                <Text numberOfLines={1} style={styles.rowTitle}>
                  {label}
                </Text>
                {url ? <Icon as={ChevronRight} size={14} color={color.textMicro} /> : null}
              </PressableScale>
            )
          })}
        </Part>
      ) : null}
      <ArtifactViewer
        artifact={openArtifact}
        url={openArtifact ? issueArtifactHref(issue, openArtifact, httpOrigin) : null}
        onClose={() => setOpenArtifact(null)}
      />

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
                  <AgentMark kind={session.agentKind} size={markSize(SESSION_CHIP)} ink={tone.fg} />
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
    width: SESSION_CHIP,
    height: SESSION_CHIP,
    borderRadius: radius.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: color.accent },

  branch: { ...mono(400), fontSize: font.micro, color: color.accentTint },
  gitLine: { ...mono(400), fontSize: font.micro, color: color.textFaint, marginTop: 4 },
})
