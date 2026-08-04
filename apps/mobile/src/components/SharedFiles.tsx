import { isImagePath } from '@podium/client-core/viewmodels'
import type { TranscriptItem } from '@podium/model'
import { FileText, X } from 'lucide-react-native'
import { useState } from 'react'
import { Image, Linking, Modal, StyleSheet, Text, View } from 'react-native'
import {
  pathBasename,
  sessionAssetUrl,
  type TranscriptAssetContext,
} from '../lib/transcript-assets'
import { color, font, leading, monoLabel, radius, sans, space } from '../theme/theme'
import { Icon } from './Icon'
import { PressableScale } from './PressableScale'

function FileChip({ label, url, onPress }: { label: string; url?: string; onPress?: () => void }) {
  const interactive = url !== undefined || onPress !== undefined
  return (
    <PressableScale
      accessibilityRole={interactive ? 'button' : undefined}
      accessibilityLabel={interactive ? `Open ${label}` : undefined}
      disabled={!interactive}
      onPress={onPress ?? (url ? () => void Linking.openURL(url) : undefined)}
      style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
    >
      <Icon as={FileText} size={13} color={color.textDim} />
      <Text style={styles.chipText} numberOfLines={1}>
        {label}
      </Text>
    </PressableScale>
  )
}

function SharedPath({ path, context }: { path: string; context?: TranscriptAssetContext }) {
  const [failed, setFailed] = useState(false)
  const [preview, setPreview] = useState(false)
  const name = pathBasename(path)
  const url = context ? sessionAssetUrl(context, path) : undefined

  if (!url || !isImagePath(path) || failed) return <FileChip label={name} url={url} />

  return (
    <>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`Open image ${name}`}
        onPress={() => setPreview(true)}
        style={({ pressed }) => [styles.thumbButton, pressed && styles.chipPressed]}
      >
        <Image
          source={{ uri: url }}
          accessibilityLabel={name}
          resizeMode="cover"
          style={styles.thumb}
          onError={() => setFailed(true)}
        />
      </PressableScale>
      <Modal
        visible={preview}
        transparent
        animationType="fade"
        onRequestClose={() => setPreview(false)}
      >
        <View style={styles.lightbox}>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Close image"
            onPress={() => setPreview(false)}
            hitSlop={12}
            style={styles.lightboxClose}
          >
            <Icon as={X} size={22} color={color.text} />
          </PressableScale>
          <Image
            source={{ uri: url }}
            accessibilityLabel={name}
            resizeMode="contain"
            style={styles.lightboxImage}
            onError={() => {
              setFailed(true)
              setPreview(false)
            }}
          />
        </View>
      </Modal>
    </>
  )
}

export function SharedFiles({
  item,
  context,
  showHeader = true,
}: {
  item: TranscriptItem
  context?: TranscriptAssetContext
  showHeader?: boolean
}) {
  const paths = item.toolPaths ?? []
  const tags = paths.length === 0 ? (item.tags ?? []) : []
  if (paths.length === 0 && tags.length === 0) return null

  return (
    <View style={styles.root}>
      {showHeader ? (
        <Text style={styles.label}>{paths.length === 1 ? 'Shared a file' : 'Shared files'}</Text>
      ) : null}
      {showHeader && item.toolTitle ? <Text style={styles.caption}>{item.toolTitle}</Text> : null}
      <View style={styles.files}>
        {paths.map((path) => (
          <SharedPath key={path} path={path} context={context} />
        ))}
        {tags.map((tag, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: transcript tags have no identity and are immutable
          <FileChip key={`${tag.kind}:${tag.label}:${index}`} label={tag.label ?? tag.kind} />
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { gap: space.xs + 1, marginVertical: space.xs },
  label: { ...monoLabel(font.micro), color: color.textDim },
  caption: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.small,
    lineHeight: leading(font.small),
  },
  files: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    maxWidth: 240,
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  chipPressed: { opacity: 0.65 },
  chipText: { ...sans(500), flexShrink: 1, color: color.textDim, fontSize: font.small },
  thumbButton: {
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  thumb: { width: 220, height: 140, backgroundColor: color.surface },
  lightbox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.92)',
    padding: space.lg,
  },
  lightboxClose: {
    position: 'absolute',
    top: 48,
    right: space.lg,
    zIndex: 2,
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: color.surfaceHigh,
  },
  lightboxImage: { width: '100%', height: '82%' },
})
