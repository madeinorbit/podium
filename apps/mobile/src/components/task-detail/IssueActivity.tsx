import { relativeTime } from '@podium/client-core/focus'
import type { IssueWithBodies } from '@podium/client-core/replica'
import {
  type ActivityEntry,
  type ActivityItem,
  groupActivityFeed,
  type IssueEventLine,
} from '@podium/client-core/values'
import type { IssueHistoryView } from '@podium/client-graph/issue-activity'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { issueObserver as observer } from '../../client/issue-observer'
import { useAgeNow } from '../../lib/clock-hooks'
import type { IssueCommands, IssueMailMessage } from '../../lib/issue-detail'
import { compactAge } from '../../screens/TasksSurface.types'
import { color, font, leading, radius, sans, space } from '../../theme/theme'
import { Icon } from '../Icon'
import { ChevronDown, ChevronRight, Mail } from '../icons'
import { PressableScale } from '../PressableScale'
import { SectionHeading } from './chrome'
import { DetailText as Text } from './DetailText'
import { useDetailLayout } from './detail-type'
import { IssueAge } from './IssueAge'
import { GroupHeading } from './TaskOverview'

/**
 * The activity half of the task page [POD-724]: agent mail, the assistant note,
 * and the day-grouped comment/event feed. The composer is NOT here — the screen
 * pins it below the scroll, because a reply box at the end of a day of events is
 * a reply box nobody reaches.
 *
 * The grouping, the rollups and the clock formatting are the SHARED derivation
 * (`@podium/client-core/values/issue-activity`), which is what keeps the
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

export const MailSection = observer(function MailSection({
  mail,
  headless = false,
}: {
  mail: IssueMailMessage[]
  /** Inside a fold whose header already names it. */
  headless?: boolean
}) {
  if (mail.length === 0) return null
  return (
    <View style={headless ? undefined : styles.section} testID="issue-mail">
      {headless ? null : <SectionHeading label="Mail" count={String(mail.length)} />}
      {mail.map((m) => (
        <View key={m.id} style={styles.mail}>
          <View style={styles.mailHead}>
            <Icon
              as={Mail}
              size={12}
              color={m.status === 'unread' ? color.needsYouText : color.textFaint}
            />
            <Text style={styles.mailFrom}>{m.fromAuthor}</Text>
            {m.status === 'unread' ? <Text style={styles.unread}>UNREAD</Text> : null}
            {m.status === 'claimed' && m.claimedBy ? (
              <Text style={styles.claimed}>claimed · {m.claimedBy}</Text>
            ) : null}
            <Text style={styles.stamp}>
              <IssueAge stamp={m.createdAt} />
            </Text>
          </View>
          <Text style={styles.mailBody} selectable>
            {m.body}
          </Text>
        </View>
      ))}
    </View>
  )
})

export const IssueActivitySection = observer(function IssueActivitySection({
  feed,
  history,
}: {
  issue: IssueWithBodies
  busy: boolean
  commands: IssueCommands
  feed: ActivityItem[] | typeof LOADING
  revision?: number
  history?: IssueHistoryView
}) {
  if (feed === LOADING)
    return (
      <View testID="issue-activity" accessibilityState={{ busy: true }} aria-busy>
        <GroupHeading label="Activity" />
      </View>
    )
  // The board's activity list: newest first, one line per entry, in one card.
  // The day grouping still collapses runs of minor events into a rollup; the
  // day labels themselves are not drawn, each row carries its own age. The
  // state paragraph (activityNotes) is the summary card's at the top, so it is
  // not repeated here.
  const entries = groupActivityFeed(feed, Date.now())
    .flatMap((day) => day.entries)
    .reverse()
  return (
    <View testID="issue-activity">
      <GroupHeading label="Activity" />
      {entries.length === 0 && !history?.hasEarlier && !history?.error ? (
        <View style={styles.card}>
          <Text style={styles.emptyInCard}>
            Nothing has happened on this task yet. Comments and state changes land here.
          </Text>
        </View>
      ) : (
        <View style={styles.card} testID="activity-feed">
          {entries.map((entry, index) => (
            <EntryRow key={entry.id} entry={entry} first={index === 0} />
          ))}
          {history ? <EarlierActivity history={history} first={entries.length === 0} /> : null}
        </View>
      )}
    </View>
  )
})

/** Full history is on request: the feed opens on its newest page, and this
 *  row, last in the card, pages further back each time it is pressed. */
const EarlierActivity = observer(function EarlierActivity({
  history,
  first,
}: {
  history: IssueHistoryView
  first: boolean
}) {
  const { accessorySize } = useDetailLayout()
  if (!history.hasEarlier && !history.error) return null
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel="Show earlier activity"
      accessibilityState={{ disabled: history.loading }}
      disabled={history.loading}
      onPress={() => void history.loadEarlier()}
      scaleTo={1}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      testID="activity-earlier"
    >
      {first ? null : (
        <View style={[styles.separator, { left: space.md + accessorySize(14) + space.sm }]} />
      )}
      <View style={[styles.gutter, { width: accessorySize(14) }]} />
      <Text style={styles.earlier}>
        {history.loading
          ? 'Loading earlier activity…'
          : history.error
            ? `Could not load earlier activity: ${history.error}. Tap to retry.`
            : 'Show earlier activity'}
      </Text>
    </PressableScale>
  )
})

type RowMark = 'needs' | 'working' | 'resting' | 'done'

/** The board's three shapes, read from the event's own kind. */
function eventMark(line: IssueEventLine): RowMark {
  if (line.minor) return 'resting'
  if (line.icon === 'closed' || line.icon === 'integration') return 'done'
  if (line.icon === 'flagged') return 'needs'
  if (line.icon === 'moved' || line.icon === 'started' || line.icon === 'ready') return 'working'
  return 'resting'
}

function Mark({ mark }: { mark: RowMark }) {
  const { accessorySize } = useDetailLayout()
  if (mark === 'needs' || mark === 'done')
    return (
      <View
        style={[
          styles.dot,
          { width: accessorySize(8), height: accessorySize(8), borderRadius: accessorySize(4) },
          { backgroundColor: mark === 'done' ? color.successText : color.needsYouText },
        ]}
      />
    )
  return (
    <View
      style={[
        styles.ring,
        {
          width: accessorySize(8),
          height: accessorySize(8),
          borderRadius: accessorySize(4),
          borderWidth: accessorySize(1.5),
        },
        { borderColor: mark === 'working' ? color.workingText : color.textFaint },
      ]}
    />
  )
}

/** First letter up: the event formatter writes "moved to Review" for prose. */
const sentence = (text: string) => (text ? text[0]?.toUpperCase() + text.slice(1) : text)

function Age({ stamp }: { stamp: string }) {
  return compactAge(relativeTime(stamp, useAgeNow(stamp)))
}

const EntryRow = observer(function EntryRow({
  entry,
  first,
}: {
  entry: ActivityEntry
  first: boolean
}) {
  const [open, setOpen] = useState(false)
  if (entry.kind === 'comment')
    return (
      <Row
        first={first}
        mark="resting"
        title={entry.body.trim()}
        meta={entry.author}
        ts={entry.ts}
        selectable
      />
    )
  if (entry.kind === 'event')
    return (
      <Row
        first={first}
        mark={eventMark(entry.line)}
        title={sentence(entry.line.text)}
        ts={entry.ts}
      />
    )
  return (
    <>
      <Row
        first={first}
        mark="resting"
        title={entry.label}
        ts={entry.ts}
        expanded={open}
        onPress={() => setOpen((value) => !value)}
      />
      {open
        ? entry.items.map((item) =>
            item.kind === 'event' ? (
              <Row
                key={item.id}
                first={false}
                mark={eventMark(item.line)}
                title={sentence(item.line.text)}
                ts={item.ts}
              />
            ) : null,
          )
        : null}
    </>
  )
})

/** One activity row: mark, one-line title, then "Author · 6m" underneath. */
function Row({
  first,
  mark,
  title,
  meta,
  ts,
  expanded,
  onPress,
  selectable,
}: {
  first: boolean
  mark: RowMark
  title: string
  meta?: string
  ts: string
  expanded?: boolean
  onPress?: () => void
  selectable?: boolean
}) {
  const { size, accessorySize } = useDetailLayout()
  const body = (
    <>
      {first ? null : (
        <View style={[styles.separator, { left: space.md + accessorySize(14) + space.sm }]} />
      )}
      <View
        style={[styles.gutter, { width: accessorySize(14), height: size(leading(font.small)) }]}
      >
        <Mark mark={mark} />
      </View>
      <View style={styles.main}>
        <Text lineBreakStrategyIOS="standard" style={styles.title} selectable={selectable}>
          {title}
        </Text>
        <Text style={styles.meta}>
          {meta ? `${meta} · ` : ''}
          <Age stamp={ts} />
        </Text>
      </View>
      {onPress ? (
        <View style={{ height: size(leading(font.small)), justifyContent: 'center' }}>
          <Icon
            as={expanded ? ChevronDown : ChevronRight}
            size={accessorySize(14)}
            color={color.textFaint}
          />
        </View>
      ) : null}
    </>
  )
  if (!onPress)
    return (
      <View style={styles.row} testID="activity-event">
        {body}
      </View>
    )
  return (
    <PressableScale
      accessibilityRole="button"
      // `aria-expanded` beside `accessibilityState`: react-native-web 0.21 reads
      // only the former. [POD-1664]
      accessibilityState={{ expanded: expanded === true }}
      aria-expanded={expanded === true}
      accessibilityLabel={title}
      onPress={onPress}
      scaleTo={1}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      testID="activity-rollup"
    >
      {body}
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  card: {
    borderCurve: 'continuous',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: color.groupedCard,
  },
  emptyInCard: {
    ...sans(400),
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    color: color.textDim,
    fontSize: font.small,
  },
  row: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
  },
  rowPressed: { backgroundColor: color.surfacePressed },
  separator: {
    position: 'absolute',
    top: 0,
    left: 34,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.hairline,
  },
  gutter: { width: 14, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  ring: { width: 8, height: 8, borderRadius: 4, borderWidth: 1.5 },
  main: { flex: 1, minWidth: 0, gap: space.xs },
  title: { ...sans(400), color: color.text, fontSize: font.small, lineHeight: leading(font.small) },
  meta: { ...sans(400), color: color.textFaint, fontSize: font.tiny },
  earlier: { ...sans(400), flex: 1, color: color.textDim, fontSize: font.small },
  section: {
    paddingBottom: 0,
  },
  mail: {
    gap: space.sm,
    marginBottom: space.sm,
    padding: space.md,
    borderRadius: radius.card,
    backgroundColor: color.groupedCard,
  },
  mailHead: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.sm,
  },
  mailFrom: {
    ...sans(400),
    flexShrink: 1,
    color: color.textDim,
    fontSize: font.tiny,
  },
  unread: {
    ...sans(600),
    color: color.needsYouText,
    fontSize: font.tiny,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.xs,
    overflow: 'hidden',
    backgroundColor: color.needsYouSoft,
  },
  claimed: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.tiny,
  },
  mailBody: {
    ...sans(400),
    color: color.body,
    fontSize: font.small,
    lineHeight: leading(font.small, 'prose'),
  },
  stamp: {
    ...sans(400),
    marginLeft: 'auto',
    color: color.textMicro,
    fontSize: font.tiny,
  },
  empty: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.tiny,
    paddingVertical: space.xs,
  },
})
