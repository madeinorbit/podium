import { FileText, X } from 'lucide-react-native'
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native'
import { color, font, mono, radius, sans, space } from '../theme/theme'
import { Icon } from './Icon'
import { PressableScale } from './PressableScale'
import type { ComposerAttachment } from './useComposerAttachments'

/**
 * The chips above the composer field: what is about to ride with this prompt.
 *
 * A chip has to say three things at a glance — what it is, whether it made it,
 * and how to take it back — inside about 64pt of height, which is all a floating
 * capsule can spend before it starts eating the conversation. An image says it
 * by BEING itself; anything else says it with a glyph and a name. The upload
 * state is a dim veil rather than a spinner: a spinner on a thumbnail reads as
 * "loading the picture", which is the one thing that is not happening.
 */
export function AttachmentStrip({
  attachments,
  onRemove,
}: {
  attachments: readonly ComposerAttachment[]
  onRemove: (id: string) => void
}) {
  if (attachments.length === 0) return null
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.strip}
      style={styles.scroller}
    >
      {attachments.map((attachment) => {
        const failed = attachment.state === 'failed'
        return (
          <View
            key={attachment.id}
            testID="composer-attachment"
            style={[styles.chip, failed && styles.chipFailed]}
          >
            {attachment.previewUri ? (
              <Image
                source={{ uri: attachment.previewUri }}
                accessibilityLabel={attachment.name}
                resizeMode="cover"
                style={[styles.thumb, attachment.state === 'uploading' && styles.pending]}
              />
            ) : (
              <View style={[styles.doc, attachment.state === 'uploading' && styles.pending]}>
                <Icon as={FileText} size={14} color={color.textDim} />
                <Text style={styles.docName} numberOfLines={1}>
                  {attachment.name}
                </Text>
              </View>
            )}
            {failed ? <Text style={styles.failedMark}>failed</Text> : null}
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={`Remove ${attachment.name}`}
              onPress={() => onRemove(attachment.id)}
              hitSlop={8}
              style={styles.remove}
            >
              <Icon as={X} size={11} color={color.bg} />
            </PressableScale>
          </View>
        )
      })}
    </ScrollView>
  )
}

const CHIP = 52

const styles = StyleSheet.create({
  scroller: {
    // The strip must not grow the capsule beyond its own content: a horizontal
    // ScrollView with no bound takes every pixel the column offers.
    flexGrow: 0,
    marginBottom: space.sm,
  },
  strip: {
    flexDirection: 'row',
    gap: space.sm,
    // Room at the top-right for the remove target, which overhangs the chip.
    paddingTop: 5,
    paddingRight: 5,
  },
  chip: {
    height: CHIP,
    borderRadius: radius.md,
    overflow: 'visible',
  },
  chipFailed: {
    opacity: 0.75,
  },
  thumb: {
    width: CHIP,
    height: CHIP,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.elevated,
  },
  doc: {
    height: CHIP,
    maxWidth: 148,
    minWidth: 92,
    paddingHorizontal: space.sm,
    gap: 3,
    alignItems: 'flex-start',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.elevated,
  },
  docName: {
    ...sans(500),
    color: color.textDim,
    fontSize: font.micro,
  },
  pending: {
    opacity: 0.5,
  },
  failedMark: {
    ...mono(500),
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 4,
    textAlign: 'center',
    color: color.danger,
    fontSize: font.micro,
  },
  remove: {
    position: 'absolute',
    top: -5,
    right: -5,
    width: 18,
    height: 18,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.text,
  },
})
