import type { IssueViewModel } from '@podium/client-core/replica'
import { otherMembersSessions } from '@podium/client-graph/issue-shared-detail'
import type { MemberRoster } from '@podium/client-graph/member-roster'
import type { IssueSessionSummaryEntry } from '@podium/model'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { issueObserver as observer } from '../../client/issue-observer'
import { memberDisplayName } from '../../client/member-roster'
import { useIssueSharedDetail } from '../../client/use-issue-shared-detail'
import { alpha } from '../../theme/mix'
import { color, font, mono, radius, sans, space } from '../../theme/theme'
import { ActionSheet } from '../ActionSheet'
import { PressableScale } from '../PressableScale'
import { MachineLabel, SectionHeading } from './chrome'

type Roster = Pick<MemberRoster, 'shared' | 'members' | 'currentMemberId' | 'nameOf'>

/**
 * THE SHARED HALF OF THE PHONE TASK PAGE (POD-6297; design §2.2, §2.3), the
 * phone's counterpart of the web page's assignee row, collaborators and other
 * members' sessions (POD-6295).
 *
 * - **Assignee.** The task's one accountable human, by name. Where the server
 *   says this reader may reassign, the row opens a sheet of the active members;
 *   the pick goes through `issues.update`'s `assignee`, which the server records
 *   as an attributed reassignment. An old free-text label shows only as a note.
 * - **Collaborators.** The members who started or joined the task.
 * - **Other members' sessions (D13).** Owner, title, live or idle. Plain rows:
 *   the reader cannot open, read or drive another member's session, so nothing
 *   here offers to.
 *
 * Only on a shared instance: a one-member task page looks as it did.
 */
export const IssueSharedSection = observer(function IssueSharedSection({
  issue,
  roster,
  busy,
  onReassign,
}: {
  issue: IssueViewModel
  roster: Roster | undefined
  busy: boolean
  onReassign: (memberId: string) => void
}) {
  const shared = roster?.shared === true
  const detail = useIssueSharedDetail(issue.id, shared)
  const [picking, setPicking] = useState(false)
  if (!shared || !roster) return null
  const assignee = issue.assignee ?? issue.owner ?? null
  const legacy = issue.legacyAssignee ?? null
  const name = memberDisplayName(roster, assignee, assignee ? null : legacy)
  const mayReassign =
    detail?.allowed?.reassign === true && roster.members.some((m) => m.id !== assignee)
  const collaborators = (detail?.collaboratorIds ?? []).map((id) => memberDisplayName(roster, id))
  const others = otherMembersSessions(detail?.sessionSummaries ?? [], roster.currentMemberId)
  return (
    <View style={styles.section} testID="issue-shared-section">
      <View style={styles.row}>
        <MachineLabel>Assignee</MachineLabel>
        {mayReassign ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Assignee ${name} — reassign`}
            accessibilityHint="Opens a picker"
            disabled={busy}
            onPress={() => setPicking(true)}
            hitSlop={4}
            style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
          >
            <Text style={styles.chipText} numberOfLines={1}>
              {name}
            </Text>
            <Text style={styles.caret}>▾</Text>
          </PressableScale>
        ) : (
          <Text style={styles.value} accessibilityLabel={`Assignee ${name}`} numberOfLines={1}>
            {name}
          </Text>
        )}
        {legacy && assignee ? (
          <Text style={styles.note} numberOfLines={1}>
            {`Earlier label: ${legacy}`}
          </Text>
        ) : null}
      </View>
      {collaborators.length > 0 ? (
        <View style={styles.row}>
          <MachineLabel>Collaborators</MachineLabel>
          <Text style={styles.value}>{collaborators.join(', ')}</Text>
        </View>
      ) : null}
      {others.length > 0 ? (
        <View style={styles.sessions} testID="other-member-sessions">
          <SectionHeading label="Other members’ sessions" count={String(others.length)} />
          {others.map((summary, index) => (
            <OtherMemberSessionRow
              // biome-ignore lint/suspicious/noArrayIndexKey: D13 carries no session id; owner, title and order are the row
              key={`${summary.owner ?? ''}|${summary.title}|${index}`}
              summary={summary}
              owner={summary.owner ? memberDisplayName(roster, summary.owner) : 'a member'}
            />
          ))}
        </View>
      ) : null}
      <ActionSheet
        visible={picking}
        title="Reassign to"
        actions={roster.members.map((member) => ({
          label: memberDisplayName(roster, member.id),
          selected: member.id === assignee,
          onPress: () => {
            if (member.id !== assignee) onReassign(member.id)
          },
        }))}
        onClose={() => setPicking(false)}
      />
    </View>
  )
})

/** Another member's session, as D13 lets a task reader see it: no control. */
function OtherMemberSessionRow({
  summary,
  owner,
}: {
  summary: IssueSessionSummaryEntry
  owner: string
}) {
  const live = summary.state === 'live'
  return (
    <View
      style={styles.session}
      accessible
      accessibilityLabel={`${summary.title}, ${owner}’s session, ${live ? 'live' : 'idle'}. Only ${owner} can open it.`}
      testID="other-member-session"
    >
      <View style={[styles.dot, live ? styles.dotLive : styles.dotIdle]} />
      <Text style={styles.sessionTitle} numberOfLines={1}>
        {summary.title}
      </Text>
      <Text style={styles.owner} numberOfLines={1}>
        {owner}
      </Text>
      <Text style={styles.state}>{live ? 'live' : 'idle'}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  section: { paddingBottom: space.md },
  row: {
    gap: 5,
    paddingVertical: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: alpha(color.hairline, 0.8),
  },
  value: { ...sans(500), color: color.body, fontSize: font.small },
  note: { ...mono(400), color: color.textFaint, fontSize: font.micro },
  chip: {
    alignSelf: 'flex-start',
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    maxWidth: '100%',
    paddingHorizontal: space.sm + 2,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  chipPressed: { backgroundColor: color.surfacePressed },
  chipText: { ...sans(500), flexShrink: 1, color: color.body, fontSize: font.small },
  caret: { ...mono(400), color: color.textFaint, fontSize: 10 },
  sessions: { paddingTop: space.sm },
  session: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  dotLive: { backgroundColor: color.workingText },
  dotIdle: { borderWidth: 1, borderColor: color.textFaint },
  sessionTitle: { ...sans(500), flex: 1, minWidth: 0, color: color.body, fontSize: font.small },
  owner: { ...sans(400), maxWidth: '35%', color: color.textDim, fontSize: font.tiny },
  state: { ...mono(400), color: color.textFaint, fontSize: font.micro },
})
