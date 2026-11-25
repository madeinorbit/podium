import type { IssueWithBodies } from '@podium/client-core/replica'
import { artifactKind } from '@podium/client-core/values'
import { LOADING } from '@podium/client-graph/loading'
import type { IssuePanelArtifact } from '@podium/model'
import { useState } from 'react'
import { Image, StyleSheet, View } from 'react-native'
import { authenticatedImageSource } from '../../client/authenticated-assets'
import { useHttpOrigin } from '../../client/hooks'
import { issueObserver as observer } from '../../client/issue-observer'
import { useServerProfile } from '../../client/ServerProfileGate'
import { useOptionalServerProfile } from '../../client/server-profile-context'
import { issueArtifactHref, issueArtifactLabel } from '../../lib/issue-artifacts'
import { color, font, leading, radius, sans, space } from '../../theme/theme'
import { ArtifactViewer, type ArtifactViewerItem } from '../ArtifactViewer'
import { BodyPending } from '../BodyPending'
import { Icon } from '../Icon'
import { FileText, Play } from '../icons'
import { PressableScale } from '../PressableScale'
import { SectionHeading } from './chrome'
import { DetailText as Text } from './DetailText'
import { useDetailSize } from './detail-type'
import { IssueAge } from './IssueAge'

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
export const IssueAgentPanel = observer(function IssueAgentPanel({
  issue,
  only,
}: {
  issue: IssueWithBodies
  /** Draw one half: the artifact list (behind the strip's "See all"), or the
   *  deferred items. Both when absent. */
  only?: 'artifacts' | 'deferred'
}) {
  const size = useDetailSize()
  const httpOrigin = useHttpOrigin()
  const profile = useOptionalServerProfile()
  // Prefer the immutable hosted id. The slug fallback keeps URL-selected web
  // profiles scoped when an id is not available yet.
  const workspace = profile?.config.workspaceId ?? profile?.config.workspaceSlug

  const [openKey, setOpenKey] = useState<string | null>(null)
  const panel = issue.panel
  if (panel === LOADING) return <BodyPending label={only ?? 'Artifacts and deferred items'} />
  const artifacts = only === 'deferred' ? [] : (panel?.artifacts ?? [])
  const deferred = only === 'artifacts' ? [] : (panel?.deferred ?? [])
  if (artifacts.length === 0 && deferred.length === 0) return null
  // One viewer for the whole list, so it pages ("2 of 3") between artifacts.
  const items: ArtifactViewerItem[] = artifacts
    .map((artifact) => ({
      key: `${artifact.path}@${artifact.addedAt}`,
      artifact,
      url: issueArtifactHref(issue, artifact, httpOrigin, workspace),
    }))
    .filter((item) => item.url !== null)
  const openIndex = items.findIndex((item) => item.key === openKey)

  return (
    <View testID="issue-panel-sections">
      {artifacts.length > 0 ? (
        <View style={styles.section} testID="issue-artifacts">
          {only === 'artifacts' ? null : (
            <SectionHeading label="Artifacts" count={String(artifacts.length)} />
          )}
          {artifacts.map((a) => (
            <ArtifactRow
              key={`${a.addedAt}:${a.path}`}
              artifact={a}
              url={issueArtifactHref(issue, a, httpOrigin, workspace)}
              onOpen={() => setOpenKey(`${a.path}@${a.addedAt}`)}
            />
          ))}
          {openIndex >= 0 ? (
            <ArtifactViewer items={items} index={openIndex} onClose={() => setOpenKey(null)} />
          ) : null}
        </View>
      ) : null}

      {deferred.length > 0 ? (
        <View style={styles.section} testID="issue-deferred">
          <SectionHeading label="Deferred" count={String(deferred.length)} />
          {deferred.map((d) => (
            <View key={`${d.addedAt}:${d.text}`} style={styles.deferred}>
              <View
                style={[
                  styles.deferredDot,
                  { width: size(4), height: size(4), borderRadius: size(2) },
                ]}
              />
              <Text style={styles.deferredText}>{d.text}</Text>
              <Text style={styles.stamp}>
                <IssueAge stamp={d.addedAt} />
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  )
})

/**
 * One artifact. Images and video posters preview inline; everything else is a
 * file row. A row with no reachable URL — a legacy path-only entry on a machine
 * this phone cannot reach — stays inert rather than offering a tap that fails.
 */
const ArtifactRow = observer(function ArtifactRow({
  artifact,
  url,
  onOpen,
}: {
  artifact: IssuePanelArtifact
  url: string | null
  onOpen: () => void
}) {
  const size = useDetailSize()
  const { bearer } = useServerProfile()
  const [broken, setBroken] = useState(false)
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
          onPress={onOpen}
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
            <Text style={styles.captionText}>{label}</Text>
            <Text style={styles.stamp}>
              <IssueAge stamp={artifact.addedAt} />
            </Text>
          </View>
        </PressableScale>
      ) : (
        <PressableScale
          accessibilityRole={canOpen ? 'button' : undefined}
          accessibilityLabel={canOpen ? `Open ${label}` : label}
          disabled={!canOpen}
          onPress={canOpen ? onOpen : undefined}
          style={({ pressed }) => [styles.fileRow, pressed && styles.rowPressed]}
        >
          <Icon as={kind === 'video' ? Play : FileText} size={size(15)} color={color.textDim} />
          <Text style={styles.fileName}>{label}</Text>
          <Text style={styles.stamp}>
            <IssueAge stamp={artifact.addedAt} />
          </Text>
        </PressableScale>
      )}
    </>
  )
})

const styles = StyleSheet.create({
  section: {
    gap: space.sm,
  },
  figure: {
    marginBottom: space.sm,
    borderRadius: radius.card,
    overflow: 'hidden',
    backgroundColor: color.groupedCard,
  },
  preview: {
    width: '100%',
    height: 176,
    backgroundColor: color.bgSunken,
  },
  caption: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  captionText: {
    ...sans(500),
    flexGrow: 1,
    flexShrink: 1,
    color: color.body,
    fontSize: font.small,
  },
  fileRow: {
    minHeight: 44,
    paddingVertical: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 2,
    marginBottom: space.xs,
    paddingHorizontal: space.md,
    borderRadius: radius.control,
    backgroundColor: color.groupedCard,
  },
  rowPressed: {
    backgroundColor: color.surfacePressed,
  },
  fileName: {
    ...sans(400),
    flexGrow: 1,
    flexShrink: 1,
    color: color.body,
    fontSize: font.small,
  },
  stamp: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.tiny,
  },
  deferred: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
  },
  deferredDot: {
    width: 4,
    height: 4,
    borderRadius: radius.full,
    backgroundColor: color.textFaint,
  },
  deferredText: {
    ...sans(400),
    flexGrow: 1,
    flexShrink: 1,
    color: color.body,
    fontSize: font.small,
    lineHeight: leading(font.small),
  },
})
