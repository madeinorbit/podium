import { isImagePath, stagedAttachmentId } from '@podium/client-core/values'
import type { TranscriptItem } from '@podium/model'
import { machinePathBasename, resolveMachinePath } from '@podium/model'
import { useEffect, useState } from 'react'
import { Image, Linking, Modal, Platform, ScrollView, StyleSheet, Text, View } from 'react-native'
import {
  authenticatedImageSource,
  fetchAuthenticatedAsset,
  readAuthenticatedTextPreview} from '../client/authenticated-assets'
import { useChatItemAttachments, useChatUploadUrl } from '../client/chat-uploads'
import { useServerProfile } from '../client/ServerProfileGate'
import { sessionAssetUrl, type TranscriptAssetContext } from '../lib/transcript-assets'
import { color, font, leading, monoLabel, radius, sans, space } from '../theme/theme'
import { Icon } from './Icon'
import { FileText, X } from './icons'
import { PressableScale } from './PressableScale'

function FileChip({ label, onPress }: { label: string; onPress?: () => void }) {
  const interactive = onPress !== undefined
  return (
    <PressableScale
      accessibilityRole={interactive ? 'button' : undefined}
      accessibilityLabel={interactive ? `Open ${label}` : undefined}
      disabled={!interactive}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
    >
      <Icon as={FileText} size={13} color={color.textDim} />
      <Text style={styles.chipText} numberOfLines={1}>
        {label}
      </Text>
    </PressableScale>
  )
}

function SharedPath({
  path,
  context,
  uploadId,
}: {
  path: string
  context?: TranscriptAssetContext
  /** A chat upload named by its id alone (a path-less image turn). */
  uploadId?: string
}) {
  const { bearer } = useServerProfile()
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const [preview, setPreview] = useState(false)
  const name = machinePathBasename(path, context?.cwd ?? path)
  // A chat upload shows from the issue's stored copy (POD-2148); the daemon
  // file is the fallback for messages sent before it, and is swept after 24h.
  const stored = useChatUploadUrl(
    context?.sessionId,
    uploadId ?? (context ? stagedAttachmentId(resolveMachinePath(context.cwd, path)) : undefined),
    context?.httpOrigin,
  )
  const url =
    stored ?? (context && uploadId === undefined ? sessionAssetUrl(context, path) : undefined)
  // Failure belongs to the URL that failed: the issue's copy landing after a
  // swept daemon file failed gets its own attempt.
  const failed = failedUrl !== null && failedUrl === url
  const setFailed = () => setFailedUrl(url ?? null)

  if (!url) return <FileChip label={name} />

  const open = () => {
    if (Platform.OS === 'web') void Linking.openURL(url)
    else setPreview(true)
  }

  if (!isImagePath(path) || failed) {
    return (
      <>
        <FileChip label={name} onPress={open} />
        {preview ? (
          <SharedFileViewer
            name={name}
            url={url}
            bearer={bearer}
            onClose={() => setPreview(false)}
          />
        ) : null}
      </>
    )
  }

  return (
    <>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`Open image ${name}`}
        onPress={() => setPreview(true)}
        style={({ pressed }) => [styles.thumbButton, pressed && styles.chipPressed]}
      >
        <Image
          source={authenticatedImageSource(url, bearer)}
          accessibilityLabel={name}
          resizeMode="cover"
          style={styles.thumb}
          onError={setFailed}
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
            source={authenticatedImageSource(url, bearer)}
            accessibilityLabel={name}
            resizeMode="contain"
            style={styles.lightboxImage}
            onError={() => {
              setFailed()
              setPreview(false)
            }}
          />
        </View>
      </Modal>
    </>
  )
}

function SharedFileViewer({
  name,
  url,
  bearer,
  onClose,
}: {
  name: string
  url: string
  bearer: string | null
  onClose(): void
}) {
  const [body, setBody] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void fetchAuthenticatedAsset(url, bearer)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Could not load (${response.status})`)
        const text = await readAuthenticatedTextPreview(response)
        if (alive) setBody(text)
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      alive = false
    }
  }, [bearer, url])

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.fileViewer}>
        <View style={styles.fileViewerBar}>
          <Text style={styles.fileViewerTitle} numberOfLines={1}>
            {name}
          </Text>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Close file"
            onPress={onClose}
            style={styles.lightboxClose}
          >
            <Icon as={X} size={22} color={color.text} />
          </PressableScale>
        </View>
        <ScrollView contentContainerStyle={styles.fileViewerBody}>
          <Text style={styles.fileViewerText} selectable>
            {error ?? body ?? 'Loading…'}
          </Text>
        </ScrollView>
      </View>
    </Modal>
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
  const allTags = paths.length === 0 ? (item.tags ?? []) : []
  // An entry that names no path can still be a chat upload: the message the
  // server matched to it names the files by id (POD-2148). Its images stand for
  // the entry's image tags; any other tag keeps its chip.
  const matched = useChatItemAttachments(context?.sessionId, item.id)
  const uploads = paths.length === 0 ? matched.filter((a) => a.kind === 'image' && a.id) : []
  const imageTags = allTags.filter((tag) => tag.kind === 'image')
  const tags = [...imageTags.slice(uploads.length), ...allTags.filter((tag) => tag.kind !== 'image')]
  if (paths.length === 0 && uploads.length === 0 && tags.length === 0) return null

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
        {uploads.map((upload) => (
          <SharedPath key={upload.id} path={upload.filename} context={context} uploadId={upload.id} />
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
  fileViewer: { flex: 1, backgroundColor: color.bg },
  fileViewerBar: {
    minHeight: 96,
    paddingTop: 48,
    paddingHorizontal: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  fileViewerTitle: { flex: 1, color: color.text, ...sans(700), fontSize: font.body },
  fileViewerBody: { padding: space.lg },
  fileViewerText: { color: color.text, fontSize: font.small, lineHeight: leading(font.small) },
})
