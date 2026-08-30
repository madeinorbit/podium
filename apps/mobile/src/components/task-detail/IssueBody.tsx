import { relativeTime } from '@podium/client-core/focus'
import { type IssueWire, isPendingSync, isUpstreamStale, isViaHub } from '@podium/model'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { IssueCommands } from '../../lib/issue-detail'
import { alpha } from '../../theme/mix'
import { color, font, leading, mono, radius, sans, space, tracking } from '../../theme/theme'
import { RichMarkdown } from '../RichMarkdown'
import { Disclosure, InlineEditable, SectionHeading } from './chrome'

/**
 * The task's own text [POD-724]: the inline-editable title, the status strip, the
 * description, the agent brief, and the long-form spec fields agents write via
 * `podium issue update`.
 *
 * The DOSSIER RULE comes over from the desktop unchanged, because it is the rule
 * that keeps this page readable: the properties block owns ordinary editable
 * properties (stage, priority, and a non-default type), and the strip under the title
 * keeps recency plus EXCEPTIONS — draft, pinned, archived, agent-created,
 * internal, a stale hub mirror. A chip means "this one is not like the others";
 * nine chips of equal weight emphasise nothing.
 */

export function IssueTitle({
  issue,
  busy,
  commands,
}: {
  issue: IssueWire
  busy: boolean
  commands: IssueCommands
}) {
  return (
    <InlineEditable
      value={issue.title}
      placeholder="Untitled task"
      ariaLabel="Task title"
      busy={busy}
      multiline={false}
      onCommit={commands.commitTitle}
      textStyle={styles.title}
    />
  )
}

export function StatusStrip({ issue }: { issue: IssueWire }) {
  const now = Date.now()
  const created = relativeTime(issue.createdAt, now)
  const updated = relativeTime(issue.updatedAt, now)
  const facts = [
    ...(issue.closedReason ? [`Closed · ${issue.closedReason}`] : []),
    ...(created ? [`created ${created}`] : []),
    ...(updated ? [`updated ${updated}`] : []),
  ]
  const hub = isViaHub(issue)
  return (
    <View style={styles.strip}>
      {facts.length > 0 ? <Text style={styles.stripText}>{facts.join(' · ')}</Text> : null}
      {issue.draft ? <Chip label="draft" tint={color.info} /> : null}
      {issue.pinned ? (
        <Chip label="pinned" tint={color.accent} textTint={color.accentTint} />
      ) : null}
      {issue.archived ? <Chip label="archived" /> : null}
      {issue.origin === 'agent' ? (
        <Chip label="agent-created" tint={color.claude} textTint={color.claudeText} />
      ) : null}
      {issue.audience === 'agent' ? (
        <Chip label="internal" tint={color.claude} textTint={color.claudeText} />
      ) : null}
      {/* Replica PROVENANCE, read through the envelope accessors rather than off
          the entity — so when the carrier is nested this indicator does not have
          to be found and changed again. */}
      {hub ? (
        <Chip
          label={
            isUpstreamStale(issue) ? 'hub · stale' : isPendingSync(issue) ? 'hub · syncing' : 'hub'
          }
          tint={isUpstreamStale(issue) ? color.accent : color.info}
          textTint={isUpstreamStale(issue) ? color.accentTint : color.info}
        />
      ) : null}
    </View>
  )
}

function Chip({
  label,
  tint,
  textTint = tint,
}: {
  label: string
  tint?: string
  textTint?: string
}) {
  return (
    <View style={[styles.chip, tint ? { backgroundColor: alpha(tint, 0.14) } : null]}>
      <Text style={[styles.chipText, textTint ? { color: textTint } : null]}>{label}</Text>
    </View>
  )
}

export function IssueDescription({
  issue,
  busy,
  commands,
}: {
  issue: IssueWire
  busy: boolean
  commands: IssueCommands
}) {
  return (
    <View style={styles.section}>
      <InlineEditable
        value={issue.description}
        placeholder="Add a description…"
        ariaLabel="Task description"
        busy={busy}
        onCommit={commands.commitDescription}
        render={(text) => <RichMarkdown text={text} />}
      />
    </View>
  )
}

/** The agent brief, folded by default — it is long, and it is written FOR an
 *  agent. It sits between two things a human reads, so it stays a hairline and a
 *  label until asked for. */
export function IssueBrief({ issue }: { issue: IssueWire }) {
  const [open, setOpen] = useState(false)
  if (!issue.brief) return null
  return (
    <View style={styles.section}>
      <Disclosure
        label="Brief"
        hint="written for the agent"
        open={open}
        onToggle={() => setOpen((v) => !v)}
        testID="issue-brief"
      >
        <Text style={styles.brief} selectable>
          {issue.brief}
        </Text>
      </Disclosure>
    </View>
  )
}

const LONG_FORM = [
  { field: 'design', label: 'Design' },
  { field: 'acceptance', label: 'Acceptance' },
  { field: 'notes', label: 'Notes' },
] as const

/**
 * Design / Acceptance / Notes. Filled fields render as full sections with the
 * same tap-to-edit affordance as the description. Empty fields render nothing:
 * these are agent-authored spec fields, not three standing calls to start a
 * specification in the middle of the reading column.
 */
export function LongFormFields({
  issue,
  busy,
  commands,
}: {
  issue: IssueWire
  busy: boolean
  commands: IssueCommands
}) {
  const filled = LONG_FORM.filter(({ field }) => (issue[field] ?? '').trim() !== '')

  if (filled.length === 0) return null

  return (
    <View testID="long-form-fields">
      {filled.map(({ field, label }) => (
        <View key={field} style={styles.section}>
          <SectionHeading label={label} />
          <InlineEditable
            value={issue[field] ?? ''}
            placeholder={`Add ${label.toLowerCase()}…`}
            ariaLabel={`Task ${field}`}
            busy={busy}
            onCommit={(value) => commands.commitLongForm(field, value)}
            render={(text) => <RichMarkdown text={text} />}
          />
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  title: {
    ...sans(600),
    color: color.text,
    fontSize: font.title,
    lineHeight: leading(font.title),
    letterSpacing: tracking[font.title],
  },
  strip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    paddingTop: space.xs,
    paddingBottom: space.lg,
  },
  stripText: {
    ...mono(400),
    color: color.textFaint,
    fontSize: font.micro,
  },
  chip: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radius.xs,
    backgroundColor: color.idleSoft,
  },
  chipText: {
    ...mono(500),
    color: color.textDim,
    fontSize: 9.5,
    letterSpacing: 0.3,
  },
  section: {
    paddingBottom: space.xl,
  },
  brief: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.small,
    lineHeight: leading(font.small, 'prose'),
    paddingTop: space.xs,
  },
})
