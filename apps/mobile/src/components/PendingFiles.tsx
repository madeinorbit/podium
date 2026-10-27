import { FileText } from './icons'
import { useState } from 'react'
import { Image, StyleSheet, Text, View } from 'react-native'
import { authenticatedImageSource } from '../client/authenticated-assets'
import { useChatUploadUrl } from '../client/chat-uploads'
import { useServerProfile } from '../client/server-profile-context'
import type { TranscriptAssetContext } from '../lib/transcript-assets'
import { color, font, radius, sans, space } from '../theme/theme'
import { Icon } from './Icon'

type PendingFile = {
  path: string
  previewUri?: string
  name?: string
  attachmentId?: string
  kind?: 'image' | 'file'
}

function FileChip({ name }: { name: string }) {
  return (
    <View style={styles.chip}>
      <Icon as={FileText} size={13} color={color.textDim} />
      <Text style={styles.chipText} numberOfLines={1}>
        {name}
      </Text>
    </View>
  )
}

/** A file this device no longer has in hand — the server's record of the
 *  message names it by upload id — shown from the issue's stored copy
 *  (POD-2148), or as its name until that copy is there. */
function HeldFile({ file, context }: { file: PendingFile; context?: TranscriptAssetContext }) {
  const { bearer } = useServerProfile()
  const url = useChatUploadUrl(context?.sessionId, file.attachmentId, context?.httpOrigin)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const name = file.name ?? file.path
  // Only an image is drawn; a document, a copy not stored yet, or one that
  // fails to decode is its name.
  if (file.kind !== 'image' || !url || failedUrl === url) return <FileChip name={name} />
  return (
    <Image
      source={authenticatedImageSource(url, bearer)}
      accessibilityLabel={name}
      resizeMode="cover"
      style={styles.thumb}
      onError={() => setFailedUrl(url)}
    />
  )
}

/**
 * The attachments on a turn that has been sent but not yet echoed.
 *
 * Deliberately NOT `SharedFiles`, which is what renders the same files a moment
 * later. That component resolves each path through the server's authenticated
 * asset route — correct for a turn the server has confirmed, and wrong here:
 * these bytes came off this device seconds ago, so asking for them back costs a
 * round trip and an auth hop to display something already in memory, and until
 * it lands the operator's photo is a grey chip with a UUID on it.
 *
 * A file with no local preview (a PDF, a spec) shows its own name — which is
 * still better than the uploaded path's, because the upload renames it.
 */
export function PendingFiles({
  files,
  context,
}: {
  files: readonly PendingFile[]
  context?: TranscriptAssetContext
}) {
  if (files.length === 0) return null
  return (
    <View style={styles.row}>
      {files.map((file) =>
        !file.previewUri && file.attachmentId ? (
          <HeldFile key={file.attachmentId} file={file} context={context} />
        ) : file.previewUri ? (
          <Image
            key={file.path}
            source={{ uri: file.previewUri }}
            accessibilityLabel={file.name}
            resizeMode="cover"
            style={styles.thumb}
          />
        ) : (
          <FileChip key={file.path} name={file.name ?? file.path} />
        ),
      )}
    </View>
  )
}

const THUMB = 56

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    marginTop: space.xs + 1,
  },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.elevated,
  },
  chip: {
    maxWidth: 240,
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.elevated,
  },
  chipText: {
    ...sans(500),
    color: color.textDim,
    fontSize: font.micro,
  },
})
