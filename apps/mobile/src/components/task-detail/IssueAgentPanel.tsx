import { relativeTime } from '@podium/client-core/focus'
import { artifactKind } from '@podium/client-core/viewmodels'
import type { IssuePanelArtifact, IssueWire } from '@podium/model'
import { FileText, Play } from '../icons'
import { useState } from 'react'
import { Image, StyleSheet, Text, View } from 'react-native'
import { authenticatedImageSource } from '../../client/authenticated-assets'
import { useHttpOrigin } from '../../client/hooks'
import { useServerProfile } from '../../client/ServerProfileGate'
import { issueArtifactHref, issueArtifactLabel } from '../../lib/issue-artifacts'
import { color, font, leading, mono, radius, sans, space } from '../../theme/theme'
import { ArtifactViewer } from '../ArtifactViewer'
import { Icon } from '../Icon'
import { PressableScale } from '../PressableScale'
import { SectionHeading } from './chrome'

/**
 * THE AGENT-PUBLISHED PANEL (issues.panel) [POD-724] — what an agent produced
 * for the human: artifacts with inline previews and deferred items. Sections
 * render only when non-empty, so a task with no published output adds no chrome.
 *
 * Artifacts open in-app (lightbox / HTML frame / fetched text). Linking out of
 * the PWA dropped the session cookie, so a tap looked answered and showed
 * nothing.
 *
 * Agent todos deliberately do not render here. They are the agent's private
 * working checklist and duplicate the sub-tasks directly below, which are the
 * human-visible decomposition backed by real issues. The panel data and API
 * remain intact for agent tooling; this reader surface simply does not expose
 * or mutate the checklist.
 */
export function IssueAgentPanel({ issue }: { issue: IssueWire }) {
  const httpOrigin = useHttpOrigin()

  const artifacts = issue.panel?.artifacts ?? []
  const deferred = issue.panel?.deferred ?? []
  if (artifacts.length === 0 && deferred.length === 0) return null

  return (
    <View testID="issue-panel-sections">
      {artifacts.length > 0 ? (
        <View style={styles.section} testID="issue-artifacts">
          <SectionHeading label="Artifacts" count={String(artifacts.length)} />
          {artifacts.map((a) => (
            <ArtifactRow
              key={`${a.addedAt}:${a.path}`}
              artifact={a}
              url={issueArtifactHref(issue, a, httpOrigin)}
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

/**
 * One artifact. Images and video posters preview inline; everything else is a
 * file row. A row with no reachable URL — a legacy path-only entry on a machine
 * this phone cannot reach — stays inert rather than offering a tap that fails.
 */
function ArtifactRow({ artifact, url }: { artifact: IssuePanelArtifact; url: string | null }) {
  const { bearer } = useServerProfile()
  const [broken, setBroken] = useState(false)
  const [open, setOpen] = useState(false)
  const kind = artifactKind(artifact.entry ?? artifact.path)
  const label = issueArtifactLabel(artifact)
  const previewable = url !== null && !broken && (kind === 'image' || kind === 'video')
  const canOpen = url !== null

  return (
    <>
      {previewable && kind === 'image' ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={`Open ${label}`}
          onPress={() => setOpen(true)}
          style={({ pressed }) => [styles.figure, pressed && styles.rowPressed]}
        >
          <Image
            source={authenticatedImageSource(url, bearer)}
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
      ) : (
        <PressableScale
          accessibilityRole={canOpen ? 'button' : undefined}
          accessibilityLabel={canOpen ? `Open ${label}` : label}
          disabled={!canOpen}
          onPress={canOpen ? () => setOpen(true) : undefined}
          style={({ pressed }) => [styles.fileRow, pressed && styles.rowPressed]}
        >
          <Icon as={kind === 'video' ? Play : FileText} size={15} color={color.textDim} />
          <Text style={styles.fileName} numberOfLines={1}>
            {label}
          </Text>
          <Text style={styles.stamp}>{relativeTime(artifact.addedAt, Date.now())}</Text>
        </PressableScale>
      )}
      {open ? (
        <ArtifactViewer artifact={artifact} url={url} onClose={() => setOpen(false)} />
      ) : null}
    </>
  )
}

const styles = StyleSheet.create({
  section: {
    paddingBottom: space.xl,
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
