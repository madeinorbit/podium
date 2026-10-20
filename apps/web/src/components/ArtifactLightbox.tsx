import { artifactKind, artifactUrl, basename } from '@podium/client-core/values'
import type { IssuePanelArtifact } from '@podium/model/browser'
import type { JSX } from 'react'
import { currentWorkspaceSlug } from '@/lib/workspace-request'
import { MediaLightbox, type MediaLightboxItem } from './MediaLightbox'

/** Distinguish revisions of a path as well as separate artifact entries. */
export function artifactLightboxKey(artifact: IssuePanelArtifact): string {
  return JSON.stringify([artifact.path, artifact.addedAt, artifact.artifactId, artifact.entry])
}

/** Each entry point supplies its ordered artifacts; only previewable media enter
 * the gallery. Selection follows identity when artifacts are published or removed. */
export function ArtifactLightbox({
  artifacts,
  selected,
  onSelect,
  onClose,
  ...source
}: {
  artifacts: readonly IssuePanelArtifact[]
  selected: string
  onSelect: (key: string) => void
  onClose: () => void
} & Omit<Parameters<typeof artifactUrl>[0], 'artifact' | 'workspace'>): JSX.Element | null {
  const items: (MediaLightboxItem & { key: string })[] = []
  for (const artifact of artifacts) {
    const kind = artifactKind(artifact.entry ?? artifact.path)
    if (kind !== 'image' && kind !== 'video') continue
    const src = artifactUrl({ ...source, artifact, workspace: currentWorkspaceSlug() })
    if (!src) continue
    items.push({
      key: artifactLightboxKey(artifact),
      kind,
      src,
      label: artifact.title ?? basename(artifact.path),
    })
  }
  const index = items.findIndex((item) => item.key === selected)
  if (index < 0) return null
  return (
    <MediaLightbox
      items={items}
      index={index}
      onIndexChange={(next) => {
        const item = items[next]
        if (item) onSelect(item.key)
      }}
      onClose={onClose}
    />
  )
}
