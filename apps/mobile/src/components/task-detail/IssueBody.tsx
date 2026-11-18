import { relativeTime } from '@podium/client-core/focus'
import type { IssueViewModel } from '@podium/client-core/replica'
import { isPendingSync, isUpstreamStale, isViaHub } from '@podium/model'
import { isClosed } from '@podium/model/browser'
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { issueObserver as observer } from '../../client/issue-observer'
import { useIssueOpening } from '../../client/issue-opening'
import { useAgeNow } from '../../lib/clock-hooks'
import type { IssueCommands } from '../../lib/issue-detail'
import { alpha } from '../../theme/mix'
import { color, font, leading, radius, sans, space, tracking } from '../../theme/theme'
import { PressableScale } from '../PressableScale'
import { RichMarkdown, RichMarkdownPreview } from '../RichMarkdown'
import { Disclosure, InlineEditable } from './chrome'
import { DetailText as Text } from './DetailText'

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

export const IssueTitle = observer(function IssueTitle({
  issue,
  busy,
  commands,
}: {
  issue: IssueViewModel
  busy: boolean
  commands: IssueCommands
}) {
  const views = useIssueOpening()
  return (
    <InlineEditable
      value={views ? views.row(issue.id).title : issue.title}
      placeholder="Untitled task"
      ariaLabel="Task title"
      busy={busy}
      onCommit={commands.commitTitle}
      textStyle={styles.title}
      dynamicTypeRamp="title2"
    />
  )
})

export const StatusStrip = observer(function StatusStrip({
  issue,
  exceptionsOnly = false,
}: {
  issue: IssueViewModel
  /** Drop the created/updated recency when the header pills already say it. */
  exceptionsOnly?: boolean
}) {
  const createdNow = useAgeNow(issue.createdAt, 0, !exceptionsOnly)
  const updatedNow = useAgeNow(issue.updatedAt, 0, !exceptionsOnly)
  const created = relativeTime(issue.createdAt, createdNow)
  const updated = relativeTime(issue.updatedAt, updatedNow)
  const facts = [
    // The header's stage pill already says Closed when the strip rides under it.
    ...(isClosed(issue) && !exceptionsOnly ? [`Closed · ${issue.closedReason}`] : []),
    ...(created && !exceptionsOnly ? [`created ${created}`] : []),
    ...(updated && !exceptionsOnly ? [`updated ${updated}`] : []),
  ]
  const hub = isViaHub(issue)
  const exceptions =
    facts.length > 0 ||
    issue.isDraftVessel ||
    issue.pinned ||
    issue.archived ||
    issue.intentOrigin === 'agent' ||
    issue.audience === 'agent' ||
    hub
  if (!exceptions) return null
  return (
    <View style={styles.strip}>
      {facts.length > 0 ? <Text style={styles.stripText}>{facts.join(' · ')}</Text> : null}
      {issue.isDraftVessel ? <Chip label="draft" tint={color.info} /> : null}
      {issue.pinned ? (
        <Chip label="pinned" tint={color.accent} textTint={color.accentTint} />
      ) : null}
      {issue.archived ? <Chip label="archived" /> : null}
      {issue.intentOrigin === 'agent' ? (
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
})

const Chip = observer(function Chip({
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
})

export const IssueDescription = observer(function IssueDescription({
  issue,
  busy,
  commands,
}: {
  issue: IssueViewModel
  busy: boolean
  commands: IssueCommands
}) {
  return (
    <View>
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
})

export const IssueDescriptionPreview = observer(function IssueDescriptionPreview(
  props: Parameters<typeof IssueDescription>[0],
) {
  const [open, setOpen] = useState(false)
  return (
    <View style={styles.descriptionPreview} testID="issue-description-section">
      <Text style={styles.previewLabel}>Description</Text>
      {open || !props.issue.description.trim() ? (
        <IssueDescription {...props} />
      ) : (
        <RichMarkdownPreview text={props.issue.description} />
      )}
      {props.issue.description.trim() ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={open ? 'Less description' : 'More description'}
          accessibilityState={{ expanded: open }}
          aria-expanded={open}
          onPress={() => setOpen((value) => !value)}
          style={styles.previewMore}
        >
          <Text style={styles.previewMoreText}>{open ? 'Less' : 'More'}</Text>
        </PressableScale>
      ) : null}
    </View>
  )
})

/** The agent brief, folded by default — it is long, and it is written FOR an
 *  agent. It sits between two things a human reads, so it stays a hairline and a
 *  label until asked for. */
export const IssueBrief = observer(function IssueBrief({ issue }: { issue: IssueViewModel }) {
  const [open, setOpen] = useState(false)
  if (!issue.brief) return null
  // A fold among folds now: no section gap of its own.
  return (
    <View>
      <Disclosure
        label="Brief"
        hint="Instructions for the agent"
        open={open}
        onToggle={() => setOpen((v) => !v)}
        testID="issue-brief"
      >
        <RichMarkdown text={issue.brief} />
      </Disclosure>
    </View>
  )
})

const LONG_FORM = [{ field: 'acceptance', label: 'Acceptance' }] as const

/**
 * Acceptance (Design and Notes were folded into the brief, POD-6101). A filled
 * field renders as a full section with the same tap-to-edit affordance as the
 * description. An empty field renders nothing: it is an agent-authored spec
 * field, not a standing call to start a specification in the middle of the
 * reading column.
 */
export const LongFormFields = observer(function LongFormFields({
  issue,
  busy,
  commands,
}: {
  issue: IssueViewModel
  busy: boolean
  commands: IssueCommands
}) {
  const filled = LONG_FORM.filter(({ field }) => (issue[field] ?? '').trim() !== '')

  if (filled.length === 0) return null

  return (
    <View testID="long-form-fields">
      {filled.map(({ field, label }) => (
        <LongFormDisclosure key={field} label={label}>
          <InlineEditable
            value={issue[field] ?? ''}
            placeholder={`Add ${label.toLowerCase()}…`}
            ariaLabel={`Task ${field}`}
            busy={busy}
            onCommit={(value) => commands.commitLongForm(field, value)}
            render={(text) => <RichMarkdown text={text} />}
          />
        </LongFormDisclosure>
      ))}
    </View>
  )
})

function LongFormDisclosure({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <Disclosure label={label} open={open} onToggle={() => setOpen((value) => !value)}>
      {children}
    </Disclosure>
  )
}

const styles = StyleSheet.create({
  descriptionPreview: { paddingHorizontal: 20, paddingTop: 12, gap: 8 },
  previewLabel: { ...sans(400), fontSize: font.tiny, color: color.textDim },
  previewMore: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  previewMoreText: { ...sans(400), fontSize: font.body, color: color.accentTint },
  title: {
    ...sans(700),
    color: color.text,
    fontSize: font.title,
    lineHeight: leading(font.title),
    letterSpacing: tracking[font.title],
  },
  strip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.sm,
  },
  stripText: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.tiny,
  },
  chip: {
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.control,
    backgroundColor: color.idleSoft,
  },
  chipText: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.tiny,
  },
})
