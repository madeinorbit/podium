import type { IssueWire, SessionOffer } from '@podium/model'
import { FileText, Globe, Image as ImageGlyph, Play } from 'lucide-react-native'
import { useState } from 'react'
import { Image, StyleSheet, Text, View } from 'react-native'
import { authenticatedImageSource } from '../client/authenticated-assets'
import { useHttpOrigin } from '../client/hooks'
// The CONTEXT module, not the gate that composes it: a leaf reading one value
// must not drag the boot graph in behind it (see apps/mobile/vitest.config.ts).
import { useServerProfile } from '../client/server-profile-context'
import { type OfferArtifactRow, offerArtifactRows } from '../lib/offer-artifacts'
import { color, font, monoLabel, radius, sans, space } from '../theme/theme'
import { ArtifactViewer } from './ArtifactViewer'
import { Icon } from './Icon'
import { PressableScale } from './PressableScale'

/**
 * OFFER EVIDENCE, IN THE OFFER [POD-120] — the desktop strip's semantics on the
 * phone. An offer that names artifacts used to show a "2 artifacts →" link into
 * the task peek: a second surface, two taps away from the thing itself, in the
 * one block on the screen that is asking a question NOW. The evidence an agent
 * chose is part of the question, so it is drawn under it.
 *
 * The resolution is shared with the desktop ({@link offerArtifactRows} →
 * `resolveOfferArtifacts`): the offer's own paths against the issue panel in
 * offer order, newest entry per path, unresolved paths dropped, and — for an
 * offer that names none — the artifacts published since the human last typed.
 *
 * Mobile presentation, not a port of the desktop's markup: images become real
 * thumbnails, everything else a named chip wearing its kind in mono, and the
 * remainder collapses into a "+N" that opens the task's full artifact list.
 * A tap opens the SAME in-app {@link ArtifactViewer} the task page uses, so an
 * HTML artifact renders here exactly as it renders there.
 */
export function OfferArtifactStrip({
  offer,
  issue,
  lastInputAt,
  onShowAll,
}: {
  offer: SessionOffer
  /** The session's issue. Without it nothing resolves and the strip is absent. */
  issue: IssueWire | undefined
  /** SessionMeta.lastInputAt — the freshness anchor for an offer naming no paths. */
  lastInputAt?: string
  /** Where the "+N" chip goes: the task peek, which lists every artifact. Absent
   *  on a host with no peek, and the remainder is then a plain count. */
  onShowAll?: () => void
}) {
  const httpOrigin = useHttpOrigin()
  const { bearer } = useServerProfile()
  const [open, setOpen] = useState<OfferArtifactRow | null>(null)
  // Keyed, not a boolean: one unreachable thumbnail must not demote the others.
  const [broken, setBroken] = useState<readonly string[]>([])

  const { rows, extra } = offerArtifactRows({
    offer,
    issue,
    httpOrigin,
    ...(lastInputAt ? { lastInputAt } : {}),
  })
  // An empty strip renders NOTHING — no view, so no margin under the offer text.
  if (rows.length === 0) return null

  return (
    <View style={styles.strip} testID="offer-artifacts">
      {rows.map((row) => {
        const url = row.url
        const thumb = row.preview === 'image' && url !== null && !broken.includes(row.key)
        return (
          <PressableScale
            key={row.key}
            testID="offer-artifact"
            accessibilityRole={url ? 'button' : undefined}
            accessibilityLabel={url ? `Open ${row.label}` : `${row.label} — not reachable`}
            disabled={url === null}
            onPress={url ? () => setOpen(row) : undefined}
            style={({ pressed }) => [
              thumb ? styles.thumb : styles.chip,
              pressed && styles.pressed,
              url === null && styles.inert,
            ]}
          >
            {thumb && url ? (
              <Image
                source={authenticatedImageSource(url, bearer)}
                style={styles.thumbImage}
                resizeMode="cover"
                accessibilityLabel={row.label}
                // A thumbnail that will not load falls back to the named chip
                // rather than to an empty rectangle the operator cannot read.
                onError={() =>
                  setBroken((prev) => (prev.includes(row.key) ? prev : [...prev, row.key]))
                }
              />
            ) : (
              <>
                <Icon as={glyphFor(row.preview)} size={14} color={color.textDim} />
                <View style={styles.chipText}>
                  <Text style={styles.chipName} numberOfLines={1}>
                    {row.label}
                  </Text>
                  <Text style={styles.chipKind}>{row.kind}</Text>
                </View>
              </>
            )}
          </PressableScale>
        )
      })}
      {extra > 0 ? (
        onShowAll ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Show ${extra} more offer artifact${extra === 1 ? '' : 's'}`}
            testID="offer-artifact-extra"
            onPress={onShowAll}
            style={({ pressed }) => [styles.chip, styles.extra, pressed && styles.pressed]}
          >
            <Text style={styles.extraText}>{`+${extra}`}</Text>
          </PressableScale>
        ) : (
          <Text style={styles.extraText} testID="offer-artifact-extra">{`+${extra}`}</Text>
        )
      ) : null}
      {open ? (
        <ArtifactViewer artifact={open.artifact} url={open.url} onClose={() => setOpen(null)} />
      ) : null}
    </View>
  )
}

/** The chip glyph says what a tap will open before it opens: a page for HTML,
 *  a play mark for video, a document for prose and everything else. */
function glyphFor(preview: OfferArtifactRow['preview']) {
  if (preview === 'video') return Play
  if (preview === 'html') return Globe
  if (preview === 'image') return ImageGlyph
  return FileText
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    // Wraps rather than scrolls: at most three items ride here, and a
    // horizontally scrolling lane inside the transcript's own vertical list
    // would fight it for the gesture.
    flexWrap: 'wrap',
    columnGap: space.sm,
    rowGap: space.xs,
    marginTop: space.md,
  },
  /** 72×48 — the panel figure's proportions at a strip's scale, on the
   *  workhorse radius, rimmed like every other raised chip in the app. */
  thumb: {
    width: 72,
    height: 48,
    borderRadius: radius.md,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.bgSunken,
  },
  thumbImage: {
    width: '100%',
    height: '100%',
  },
  chip: {
    height: 48,
    maxWidth: 210,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.sm + 2,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  chipText: {
    flexShrink: 1,
    gap: 2,
  },
  chipName: {
    ...sans(500),
    color: color.body,
    fontSize: font.tiny,
  },
  chipKind: {
    ...monoLabel(9),
    color: color.textMicro,
  },
  pressed: {
    backgroundColor: color.surfacePressed,
  },
  /** A path this phone cannot reach stays visible — it is still evidence the
   *  agent named — but takes no press state and offers no tap. */
  inert: {
    opacity: 0.55,
  },
  extra: {
    paddingHorizontal: space.md,
  },
  extraText: {
    ...monoLabel(),
    color: color.textDim,
  },
})
