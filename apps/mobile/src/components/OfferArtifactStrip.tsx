import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionOffer } from '@podium/model'
import { useState } from 'react'
import { Image, StyleSheet, Text, View } from 'react-native'
import { authenticatedImageSource } from '../client/authenticated-assets'
import { useHttpOrigin } from '../client/hooks'
// Read the profile without importing the gate's boot graph.
import { useServerProfile } from '../client/server-profile-context'
import { OFFER_STRIP_MAX, type OfferArtifactRow, offerArtifactRows } from '../lib/offer-artifacts'
import { color, monoLabel, radius, sans, space } from '../theme/theme'
import { ArtifactViewer } from './ArtifactViewer'
import { Icon } from './Icon'
import { FileText, Globe, Image as ImageGlyph, Play } from './icons'
import { PressableScale } from './PressableScale'

const TILE_GAP = 10

/**
 * Offer evidence stays visible between the message and actions. Match the web
 * strip's equal preview tiles and captions, with at most four slots and the
 * last slot reserved for +N when the offered artifacts do not fit.
 *
 * Measure the strip rather than the screen so a narrow Tray card never wraps
 * or scrolls sideways. Taps open the phone's existing artifact viewer; +N opens
 * the task's full artifact list.
 */
export function OfferArtifactStrip({
  offer,
  issue,
  lastInputAt,
  onShowAll,
}: {
  offer: SessionOffer
  issue: IssueViewModel | undefined
  lastInputAt?: string
  onShowAll?: () => void
}) {
  const httpOrigin = useHttpOrigin()
  const { bearer, config } = useServerProfile()
  const workspace = config?.workspaceId ?? config?.workspaceSlug
  const [open, setOpen] = useState<OfferArtifactRow | null>(null)
  const [broken, setBroken] = useState<readonly string[]>([])
  const [width, setWidth] = useState(0)
  const compact = width <= 520
  const tileWidth = compact ? 112 : 148
  const previewHeight = compact ? 70 : 92
  const slots =
    width > 0
      ? Math.max(
          1,
          Math.min(OFFER_STRIP_MAX, Math.floor((width + TILE_GAP) / (tileWidth + TILE_GAP))),
        )
      : OFFER_STRIP_MAX

  const { rows, extra } = offerArtifactRows({
    offer,
    issue,
    httpOrigin,
    max: slots,
    ...(workspace ? { workspace } : {}),
    ...(lastInputAt ? { lastInputAt } : {}),
  })
  if (rows.length === 0 && extra === 0) return null

  return (
    <>
      <View
        style={styles.strip}
        testID="offer-artifacts"
        onLayout={(event) => {
          const measured = event.nativeEvent.layout.width
          if (measured > 0) setWidth(measured)
        }}
      >
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
              scaleTo={0.96}
              onPress={
                url
                  ? (event) => {
                      event.stopPropagation()
                      setOpen(row)
                    }
                  : undefined
              }
              style={({ pressed }) => [
                styles.tile,
                { width: tileWidth },
                pressed && styles.pressed,
                url === null && styles.inert,
              ]}
            >
              <View
                style={[styles.preview, { height: previewHeight }]}
                testID="offer-artifact-preview"
              >
                {thumb && url ? (
                  <Image
                    source={authenticatedImageSource(url, bearer)}
                    style={styles.image}
                    resizeMode="cover"
                    accessible={false}
                    onError={() =>
                      setBroken((prev) => (prev.includes(row.key) ? prev : [...prev, row.key]))
                    }
                  />
                ) : (
                  <View style={styles.kind}>
                    <Icon as={glyphFor(row.preview)} size={20} color={color.textDim} />
                    <Text style={styles.kindLabel}>{row.kind}</Text>
                  </View>
                )}
              </View>
              <Text style={styles.caption} numberOfLines={1} testID="offer-artifact-caption">
                {row.label}
              </Text>
            </PressableScale>
          )
        })}
        {extra > 0 ? (
          <PressableScale
            accessibilityRole={onShowAll ? 'button' : undefined}
            accessibilityLabel={`Show ${extra} more offer artifact${extra === 1 ? '' : 's'}`}
            testID="offer-artifact-extra"
            disabled={!onShowAll}
            scaleTo={0.96}
            onPress={(event) => {
              event.stopPropagation()
              onShowAll?.()
            }}
            style={({ pressed }) => [styles.tile, { width: tileWidth }, pressed && styles.pressed]}
          >
            <View style={[styles.preview, { height: previewHeight }]}>
              <Text style={styles.extraText}>{`+${extra}`}</Text>
            </View>
            <Text style={styles.caption} numberOfLines={1}>
              {onShowAll ? 'View all' : 'More artifacts'}
            </Text>
          </PressableScale>
        ) : null}
      </View>
      {open ? (
        <ArtifactViewer artifact={open.artifact} url={open.url} onClose={() => setOpen(null)} />
      ) : null}
    </>
  )
}

function glyphFor(preview: OfferArtifactRow['preview']) {
  if (preview === 'video') return Play
  if (preview === 'html') return Globe
  if (preview === 'image') return ImageGlyph
  return FileText
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: TILE_GAP,
    overflow: 'hidden',
    marginTop: space.md,
  },
  tile: {
    flexShrink: 0,
    maxWidth: '100%',
    gap: 6,
  },
  preview: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: color.borderStrong,
    backgroundColor: color.bgSunken,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  kind: {
    alignItems: 'center',
    gap: 6,
  },
  kindLabel: {
    ...monoLabel(10),
    color: color.textDim,
  },
  caption: {
    ...sans(400),
    color: color.textDim,
    fontSize: 11.5,
    lineHeight: 16,
  },
  pressed: {
    opacity: 0.8,
  },
  inert: {
    opacity: 0.55,
  },
  extraText: {
    ...sans(500),
    color: color.textDim,
    fontSize: 15,
    fontVariant: ['tabular-nums'],
  },
})
