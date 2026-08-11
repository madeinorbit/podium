import { relativeTime } from '@podium/client-core/focus'
import { artifactKind, artifactUrl, basename } from '@podium/client-core/viewmodels'
import type { IssuePanelArtifact, IssueWire } from '@podium/model'
import { Check, FileText, Play } from 'lucide-react-native'
import { useState } from 'react'
import { Image, Linking, StyleSheet, Text, View } from 'react-native'
import { useMobileStore } from '../../client/hooks'
import type { IssueCommands } from '../../lib/issue-detail'
import { alpha } from '../../theme/mix'
import { color, font, leading, mono, radius, sans, space } from '../../theme/theme'
import { Icon } from '../Icon'
import { PressableScale } from '../PressableScale'
import { Disclosure, SectionHeading } from './chrome'

/**
 * THE AGENT-PUBLISHED PANEL (issues.panel) [POD-724] — what an agent published
 * for the human: todos with a progress meter, checkable from here through the
 * same 1-based index API the desktop and the dock use; artifacts with inline
 * previews; and deferred items. Sections render only when non-empty, so a task
 * with no panel adds no chrome.
 *
 * OPEN WORK FIRST, DONE WORK FOLDED. A live task carries twenty todos and two
 * thirds of them are struck through — on a 390pt screen that is a full viewport
 * of crossed-out text between the description and everything below it. What is
 * left to do is the question this section answers; what was already done is an
 * audit trail, one tap away.
 *
 * NO PAYLOAD ISSUED FROM HERE CARRIES IDENTITY: `toggleTodo` sends the task id
 * and an index, and the artifact URLs are paths. The desktop renders an
 * attribution pair above this panel from the projection's server-stamped
 * `createdBy`; the phone reads `IssueWire`, which carries no such field, so it
 * renders NONE. Deriving one from anything else would be the synthesis
 * §3.1.3 A3 forbids — an absent pair is absent, not unknown-but-guessable.
 */
export function IssueAgentPanel({
  issue,
  busy,
  commands,
}: {
  issue: IssueWire
  busy: boolean
  commands: IssueCommands
}) {
  const store = useMobileStore()
  const [doneOpen, setDoneOpen] = useState(false)

  const todos = issue.panel?.todos ?? []
  const artifacts = issue.panel?.artifacts ?? []
  const deferred = issue.panel?.deferred ?? []
  if (todos.length === 0 && artifacts.length === 0 && deferred.length === 0) return null

  const doneCount = todos.filter((t) => t.done).length
  // The 1-based index IS the API `toggleTodo` takes, so it is carried alongside
  // each todo rather than recovered from a filtered array's position — a
  // partitioned list whose keys are its own indices toggles the wrong row.
  const indexed = todos.map((todo, index) => ({ todo, index }))
  const open = indexed.filter((t) => !t.todo.done)
  const done = indexed.filter((t) => t.todo.done)
  // A task with no dedicated worktree is worked in the repo's primary checkout —
  // serve its artifacts from there.
  const root = issue.worktreePath ?? issue.repoPath

  return (
    <View testID="issue-panel-sections">
      {todos.length > 0 ? (
        <View style={styles.section}>
          <SectionHeading label="Todo" count={`${doneCount}/${todos.length}`} />
          <View style={styles.meterRow}>
            <View style={styles.meter}>
              <View style={[styles.meterFill, { width: `${(doneCount / todos.length) * 100}%` }]} />
            </View>
            <Text style={styles.pct}>{Math.round((doneCount / todos.length) * 100)}%</Text>
          </View>
          {open.map(({ todo, index }) => (
            <TodoRow
              key={`open-${index}`}
              text={todo.text}
              done={false}
              busy={busy}
              onToggle={() => commands.toggleTodo(index + 1, true)}
            />
          ))}
          {done.length > 0 ? (
            <Disclosure
              label={`${done.length} done`}
              open={doneOpen}
              onToggle={() => setDoneOpen((v) => !v)}
            >
              {done.map(({ todo, index }) => (
                <TodoRow
                  key={`done-${index}`}
                  text={todo.text}
                  done
                  busy={busy}
                  onToggle={() => commands.toggleTodo(index + 1, false)}
                />
              ))}
            </Disclosure>
          ) : null}
        </View>
      ) : null}

      {artifacts.length > 0 ? (
        <View style={styles.section} testID="issue-artifacts">
          <SectionHeading label="Artifacts" count={String(artifacts.length)} />
          {artifacts.map((a) => (
            <ArtifactRow
              key={`${a.addedAt}:${a.path}`}
              artifact={a}
              url={artifactUrl({
                httpOrigin: store.httpOrigin,
                issueId: issue.id,
                artifact: a,
                ...(root ? { root } : {}),
                ...(issue.machineId ? { machineId: issue.machineId } : {}),
              })}
            />
          ))}
        </View>
      ) : null}

      {deferred.length > 0 ? (
        <View style={styles.section} testID="issue-deferred">
          <SectionHeading label="Deferred" count={String(deferred.length)} />
          {deferred.map((d) => (
            <View key={`${d.addedAt}:${d.text}`} style={styles.deferred}>
              <View style={styles.deferredDot} />
              <Text style={styles.deferredText}>{d.text}</Text>
              <Text style={styles.stamp}>{relativeTime(d.addedAt, Date.now())}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  )
}

/** One todo. A 44pt row whose whole width is the target — a 16px checkbox is a
 *  mouse affordance, and the text beside it is the thing a thumb aims at. */
function TodoRow({
  text,
  done,
  busy,
  onToggle,
}: {
  text: string
  done: boolean
  busy: boolean
  onToggle: () => void
}) {
  return (
    <PressableScale
      accessibilityRole="checkbox"
      accessibilityState={{ checked: done, disabled: busy }}
      accessibilityLabel={text}
      disabled={busy}
      onPress={onToggle}
      scaleTo={0.995}
      style={({ pressed }) => [styles.todo, pressed && styles.todoPressed]}
    >
      <View style={[styles.box, done && styles.boxOn]}>
        {done ? <Icon as={Check} size={12} color={color.onAccent} /> : null}
      </View>
      <Text style={[styles.todoText, done && styles.todoDone]}>{text}</Text>
    </PressableScale>
  )
}

/**
 * One artifact. Images and video posters preview inline; everything else is a
 * file row. A row with no reachable URL — a legacy path-only entry on a machine
 * this phone cannot reach — stays inert rather than offering a tap that fails.
 */
function ArtifactRow({ artifact, url }: { artifact: IssuePanelArtifact; url: string | null }) {
  const [broken, setBroken] = useState(false)
  const kind = artifactKind(artifact.entry ?? artifact.path)
  const label = artifact.title ?? basename(artifact.path)
  const previewable = url !== null && !broken && (kind === 'image' || kind === 'video')

  if (previewable && kind === 'image') {
    return (
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`Open ${label}`}
        onPress={() => void Linking.openURL(url).catch(() => setBroken(true))}
        style={({ pressed }) => [styles.figure, pressed && styles.rowPressed]}
      >
        <Image
          source={{ uri: url }}
          style={styles.preview}
          resizeMode="cover"
          accessibilityLabel={label}
          onError={() => setBroken(true)}
        />
        <View style={styles.caption}>
          <Text style={styles.captionText} numberOfLines={1}>
            {label}
          </Text>
          <Text style={styles.stamp}>{relativeTime(artifact.addedAt, Date.now())}</Text>
        </View>
      </PressableScale>
    )
  }

  return (
    <PressableScale
      accessibilityRole={url ? 'button' : undefined}
      accessibilityLabel={url ? `Open ${label}` : label}
      disabled={url === null}
      onPress={url ? () => void Linking.openURL(url).catch(() => setBroken(true)) : undefined}
      style={({ pressed }) => [styles.fileRow, pressed && styles.rowPressed]}
    >
      <Icon as={kind === 'video' ? Play : FileText} size={15} color={color.textDim} />
      <Text style={styles.fileName} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.stamp}>{relativeTime(artifact.addedAt, Date.now())}</Text>
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  section: {
    paddingBottom: space.xl,
  },
  meterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingBottom: space.sm,
  },
  meter: {
    flex: 1,
    height: 3,
    borderRadius: 2,
    overflow: 'hidden',
    backgroundColor: alpha(color.border, 0.8),
  },
  meterFill: {
    height: '100%',
    borderRadius: 2,
    // Progress asks nothing of the operator, so it is never amber.
    backgroundColor: color.working,
  },
  pct: {
    ...mono(500),
    color: color.textFaint,
    fontSize: 9.5,
  },
  todo: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 6,
    paddingHorizontal: space.sm,
    marginHorizontal: -space.sm,
    borderRadius: radius.md,
  },
  todoPressed: {
    backgroundColor: alpha(color.surface, 0.8),
  },
  box: {
    width: 20,
    height: 20,
    borderRadius: radius.xs,
    borderWidth: 1.4,
    borderColor: color.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: {
    backgroundColor: color.working,
    borderColor: color.working,
  },
  todoText: {
    ...sans(400),
    flex: 1,
    color: color.body,
    fontSize: font.small,
    lineHeight: leading(font.small),
  },
  todoDone: {
    color: color.textFaint,
    textDecorationLine: 'line-through',
  },
  figure: {
    marginBottom: space.sm,
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  preview: {
    width: '100%',
    height: 176,
    backgroundColor: color.bgSunken,
  },
  caption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  captionText: {
    ...sans(500),
    flex: 1,
    color: color.body,
    fontSize: font.tiny,
  },
  fileRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 2,
    marginBottom: space.xs,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  rowPressed: {
    backgroundColor: color.surfacePressed,
  },
  fileName: {
    ...sans(400),
    flex: 1,
    color: color.body,
    fontSize: font.tiny,
  },
  stamp: {
    ...mono(400),
    color: color.textMicro,
    fontSize: 9.5,
  },
  deferred: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: 5,
  },
  deferredDot: {
    width: 5,
    height: 5,
    borderRadius: radius.full,
    backgroundColor: color.textFaint,
  },
  deferredText: {
    ...sans(400),
    flex: 1,
    color: color.body,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny),
  },
})
