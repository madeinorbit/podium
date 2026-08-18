import { FileText } from 'lucide-react-native'
import { Image, StyleSheet, Text, View } from 'react-native'
import { color, font, radius, sans, space } from '../theme/theme'
import { Icon } from './Icon'

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
}: {
  files: readonly { path: string; previewUri: string; name: string }[]
}) {
  if (files.length === 0) return null
  return (
    <View style={styles.row}>
      {files.map((file) =>
        file.previewUri ? (
          <Image
            key={file.path}
            source={{ uri: file.previewUri }}
            accessibilityLabel={file.name}
            resizeMode="cover"
            style={styles.thumb}
          />
        ) : (
          <View key={file.path} style={styles.chip}>
            <Icon as={FileText} size={13} color={color.textDim} />
            <Text style={styles.chipText} numberOfLines={1}>
              {file.name}
            </Text>
          </View>
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
