import { relativeTime } from '@podium/client-core/focus'
import {
  type ActivityEntry,
  type ActivityItem,
  eventClock,
  groupActivityFeed,
  type IssueEventIcon,
  type IssueEventLine,
} from '@podium/client-core/viewmodels'
import type { IssueWire } from '@podium/model'
import {
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleDot,
  Flag,
  FlagOff,
  GitMerge,
  Link2,
  type LucideIcon,
  Mail,
  Play,
  RefreshCw,
  Trash2,
  Unlock,
} from 'lucide-react-native'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { IssueCommands, IssueMailMessage } from '../../lib/issue-detail'
import { alpha } from '../../theme/mix'
import { color, font, leading, mono, radius, sans, space } from '../../theme/theme'
import { Icon } from '../Icon'
import { PressableScale } from '../PressableScale'
import { MachineLabel, SectionHeading } from './chrome'

/**
 * The activity half of the task page [POD-724]: agent mail, the assistant note,
 * and the day-grouped comment/event feed. The composer is NOT here — the screen
 * pins it below the scroll, because a reply box at the end of a day of events is
 * a reply box nobody reaches.
 *
 * The grouping, the rollups and the clock formatting are the SHARED derivation
 * (`@podium/client-core/viewmodels/issue-activity`), which is what keeps the
 * phone from repeating the defect that produced it: a flat list printing raw ISO
 * strings, thirty consecutive `read 2026-08-07T20:21:24.588Z` rows between two
 * real transitions. Days carry the date, rows carry a clock time, runs of minor
 * events collapse into one line the operator can open, and comments render as
 * cards against the event spine so what a human wrote outranks what a process
 * logged.
 *
 * COMMENTS AND MAIL CARRY NO VISIBILITY OF THEIR OWN — both inherit the task. If
 * you can see this page you can see its thread; if you cannot see the task you
 * never reach this component. There is deliberately no per-comment visibility
 * affordance, and adding one would invent a policy that is settled the other way.
 */

export function MailSection({ mail }: { mail: IssueMailMessage[] }) {
  if (mail.length === 0) return null
  const now = Date.now()
  return (
    <View style={styles.section} testID="issue-mail">
      <SectionHeading label="Mail" count={String(mail.length)} />
      {mail.map((m) => (
        <View key={m.id} style={styles.mail}>
          <View style={styles.mailHead}>
            <Icon
              as={Mail}
              size={12}
              color={m.status === 'unread' ? color.needsYou : color.textFaint}
            />
            <Text style={styles.mailFrom} numberOfLines={1}>
              {m.fromAuthor}
            </Text>
            {m.status === 'unread' ? <Text style={styles.unread}>UNREAD</Text> : null}
            {m.status === 'claimed' && m.claimedBy ? (
              <Text style={styles.claimed}>claimed · {m.claimedBy}</Text>
            ) : null}
            <Text style={styles.stamp}>{relativeTime(m.createdAt, now)}</Text>
          </View>
          <Text style={styles.mailBody} selectable>
            {m.body}
          </Text>
        </View>
      ))}
    </View>
  )
}

/** Glyph per event-line kind. The pure formatter returns a stable `icon` KEY so
 *  it stays renderer-free; this is the phone's mapping of those keys, and the
 *  desktop has its own over the same set. */
const EVENT_ICONS: Record<IssueEventIcon, LucideIcon> = {
  created: CircleDot,
  moved: ArrowRight,
  closed: CheckCircle2,
  started: Play,
  attached: Link2,
  cleaned: Trash2,
  flagged: Flag,
  cleared: FlagOff,
  ready: Unlock,
  integration: GitMerge,
  generic: Circle,
}

export function IssueActivitySection({
  issue,
  busy,
  commands,
  feed,
}: {
  issue: IssueWire
  busy: boolean
  commands: IssueCommands
  feed: ActivityItem[]
}) {
  // Days are derived per render against a coarse clock: the only thing `now`
  // decides is whether a group says "Today", so re-deriving on a timer would
  // repaint the whole feed to change one word a day.
  const days = groupActivityFeed(feed, Date.now())
  return (
    <View style={styles.section}>
      <SectionHeading
        label="Activity"
        right={
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Refresh AI notes"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={commands.refreshAssistant}
            hitSlop={10}
            style={({ pressed }) => [styles.refresh, (busy || pressed) && styles.refreshMuted]}
          >
            <Icon as={RefreshCw} size={13} color={color.textDim} />
          </PressableScale>
        }
      />

      {issue.activityNotes ? (
        <View style={styles.assistant}>
          <View style={styles.assistantHead}>
            <MachineLabel>Assistant</MachineLabel>
            {issue.notesUpdatedAt ? (
              <Text style={styles.stamp}>{relativeTime(issue.notesUpdatedAt, Date.now())}</Text>
            ) : null}
          </View>
          <Text style={styles.assistantBody} selectable>
            {issue.activityNotes}
          </Text>
        </View>
      ) : null}

      {days.length === 0 ? (
        <Text style={styles.empty}>
          Nothing has happened on this task yet. Comments and state changes land here.
        </Text>
      ) : (
        <View testID="activity-feed">
          {days.map((day) => (
            <View key={day.key}>
              <View style={styles.day}>
                <MachineLabel>{day.label}</MachineLabel>
                <View style={styles.dayRule} />
              </View>
              {day.entries.map((entry) => (
                <EntryRow key={entry.id} entry={entry} />
              ))}
            </View>
          ))}
        </View>
      )}
    </View>
  )
}

function EntryRow({ entry }: { entry: ActivityEntry }) {
  if (entry.kind === 'rollup') return <Rollup entry={entry} />
  if (entry.kind === 'comment')
    return <Comment author={entry.author} body={entry.body} ts={entry.ts} />
  return <EventLine line={entry.line} ts={entry.ts} />
}

/** One transition on the timeline. The row draws its own spine and node, so the
 *  feed reads as one continuous line — a real transition lights its node, a
 *  minor one leaves it grey. */
function EventLine({ line, ts }: { line: IssueEventLine; ts: string }) {
  const EventIcon = EVENT_ICONS[line.icon] ?? EVENT_ICONS.generic
  const minor = line.minor === true
  return (
    <View style={styles.event} testID="activity-event">
      <View style={[styles.node, minor && styles.nodeMinor]} />
      <Icon as={EventIcon} size={12} color={minor ? color.textMicro : color.textFaint} />
      <Text style={[styles.eventText, minor && styles.eventMinor]}>{line.text}</Text>
      <Text style={styles.clock}>{eventClock(ts)}</Text>
    </View>
  )
}

function Rollup({ entry }: { entry: Extract<ActivityEntry, { kind: 'rollup' }> }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <PressableScale
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={entry.label}
        accessibilityHint={`between ${eventClock(entry.firstTs)} and ${eventClock(entry.ts)}`}
        onPress={() => setOpen((v) => !v)}
        scaleTo={0.997}
        style={styles.event}
        testID="activity-rollup"
      >
        <View style={[styles.node, styles.nodeMinor]} />
        <Icon as={ChevronRight} size={12} color={color.textMicro} />
        <Text style={[styles.eventText, styles.eventMinor]} numberOfLines={1}>
          {entry.label}
        </Text>
        <Text style={styles.clock}>{eventClock(entry.ts)}</Text>
      </PressableScale>
      {open
        ? entry.items.map((item) =>
            item.kind === 'event' ? (
              <EventLine key={item.id} line={item.line} ts={item.ts} />
            ) : null,
          )
        : null}
    </>
  )
}

/**
 * A comment. NO ATTRIBUTION PAIR IS SYNTHESISED HERE, and that is a measurement
 * rather than an omission: the comment shape carries `author`, `body`,
 * `createdAt` and an id — no `Attribution`. §3.1.3 A3 says the UI READS the pair
 * and never asserts it, so a row whose server shape has none renders none.
 */
function Comment({ author, body, ts }: { author: string; body: string; ts: string }) {
  return (
    <View style={styles.comment}>
      <View style={styles.commentHead}>
        <Text style={styles.commentAuthor}>{author}</Text>
        <Text style={styles.clock}>{eventClock(ts)}</Text>
      </View>
      <Text style={styles.commentBody} selectable>
        {body}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  section: {
    paddingBottom: space.xl,
  },
  refresh: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  refreshMuted: {
    opacity: 0.5,
  },
  mail: {
    gap: 5,
    marginBottom: space.sm,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  mailHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  mailFrom: {
    ...mono(400),
    flexShrink: 1,
    color: color.textDim,
    fontSize: font.micro,
  },
  unread: {
    ...mono(600),
    color: color.needsYou,
    fontSize: 9,
    letterSpacing: 0.5,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: radius.xs,
    overflow: 'hidden',
    backgroundColor: color.needsYouSoft,
  },
  claimed: {
    ...mono(400),
    color: color.textFaint,
    fontSize: 9,
  },
  mailBody: {
    ...sans(400),
    color: color.body,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny, 'prose'),
  },
  assistant: {
    gap: 4,
    marginBottom: space.sm,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    borderColor: color.border,
    backgroundColor: alpha(color.surface, 0.5),
  },
  assistantHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  assistantBody: {
    ...sans(400),
    color: color.body,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny, 'prose'),
  },
  day: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.md,
    marginBottom: space.xs,
  },
  dayRule: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.hairline,
  },
  event: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 30,
    paddingLeft: space.md,
    // The spine: a hairline down the left of every row, so the feed reads as one
    // continuous line rather than a stack of unrelated strips.
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: color.hairline,
  },
  node: {
    position: 'absolute',
    left: -3,
    top: 12,
    width: 5,
    height: 5,
    borderRadius: radius.full,
    backgroundColor: color.working,
  },
  nodeMinor: {
    backgroundColor: color.border,
  },
  eventText: {
    ...sans(400),
    flex: 1,
    color: color.textDim,
    fontSize: font.tiny,
  },
  eventMinor: {
    color: color.textMicro,
  },
  clock: {
    ...mono(400),
    color: color.textMicro,
    fontSize: 9.5,
  },
  comment: {
    gap: 4,
    marginVertical: 6,
    marginLeft: 5,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  commentHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  commentAuthor: {
    ...sans(600),
    color: color.text,
    fontSize: font.micro,
  },
  commentBody: {
    ...sans(400),
    color: color.body,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny, 'prose'),
  },
  stamp: {
    ...mono(400),
    marginLeft: 'auto',
    color: color.textMicro,
    fontSize: 9.5,
  },
  empty: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.tiny,
    paddingVertical: space.xs,
  },
})
