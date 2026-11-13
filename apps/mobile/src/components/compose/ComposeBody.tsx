import { COORDINATOR_PROMPT, countWords } from '@podium/client-core/new-task'
import { type ReactNode, type RefObject, useCallback, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Image,
  type NativeSyntheticEvent,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputKeyPressEventData,
  View,
} from 'react-native'
import { color } from '../../theme/theme'
import { AgentMark } from '../AgentMark'
import { useComposerMeasure } from '../composer-measure'
import { Glass } from '../Glass'
import { Icon } from '../Icon'
import type { AppIcon } from '../icons'
import { PressableScale } from '../PressableScale'
import type { ComposerAttachment } from '../useComposerAttachments'
import { ComposeMenu, type ComposeMenuItem } from './ComposeMenu'

export function ComposeFieldRow({
  label,
  value,
  detail,
  agent,
  items,
  disabled,
}: {
  label: string
  value: string
  detail?: string
  agent?: string
  items: readonly ComposeMenuItem[]
  disabled?: boolean
}) {
  return (
    <ComposeMenu label={label} items={items} disabled={disabled} style={{ alignSelf: 'stretch' }}>
      {(onPress) => {
        const content = (
          <>
            <Text style={styles.fieldLabel}>{label}</Text>
            <View style={styles.fieldValue}>
              {agent ? <AgentMark kind={agent} size={16} ink={color.text} /> : null}
              <Text numberOfLines={1} style={styles.value}>
                {value}
              </Text>
              {detail ? (
                <Text numberOfLines={1} style={styles.detail}>
                  {detail}
                </Text>
              ) : null}
              {items.length ? (
                <Icon as="chevron.up.chevron.down" size={10} color={color.textMicro} />
              ) : null}
            </View>
            <View pointerEvents="none" style={styles.separator} />
          </>
        )
        // SwiftUI owns the responder on iOS, as it does for NativePicker.
        return onPress ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`${label}, ${value}${detail ? `, ${detail}` : ''}`}
            onPress={onPress}
            disabled={disabled}
            style={styles.field}
          >
            {content}
          </PressableScale>
        ) : (
          <View
            accessible
            accessibilityRole="button"
            accessibilityLabel={`${label}, ${value}${detail ? `, ${detail}` : ''}`}
            style={styles.field}
          >
            {content}
          </View>
        )
      }}
    </ComposeMenu>
  )
}

export function ComposeBody({
  fields,
  prompt,
  onPrompt,
  promptRef,
  onStart,
  onCancel,
  onCoordinator,
  attachments,
  onRemoveAttachment,
  note,
  error,
  busy,
  onPhotos,
  onCamera,
  onFiles,
  bottomInset,
  keyboardLift = 0,
}: {
  fields: ReactNode
  prompt: string
  onPrompt: (prompt: string) => void
  promptRef?: RefObject<TextInput | null>
  onStart: () => void
  onCancel: () => void
  onCoordinator: () => void
  attachments: readonly ComposerAttachment[]
  onRemoveAttachment: (id: string) => void
  note?: string
  error?: string | null
  busy: boolean
  onPhotos?: () => void
  onCamera?: () => void
  onFiles?: () => void
  bottomInset: number
  keyboardLift?: number
}) {
  const words = countWords(prompt)
  const ownRef = useRef<TextInput>(null)
  const inputRef = promptRef ?? ownRef
  const [promptHeight, setPromptHeight] = useState<number>()
  const [promptWidth, setPromptWidth] = useState(0)
  const measure = useCallback((height: number) => setPromptHeight(Math.max(72, height)), [])
  useComposerMeasure(inputRef, prompt, promptWidth, measure)
  const onKeyPress = (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    const key = event.nativeEvent as TextInputKeyPressEventData & {
      metaKey?: boolean
      ctrlKey?: boolean
    }
    if (key.key === 'Escape') {
      event.preventDefault()
      onCancel()
    }
    if (key.key === 'Enter' && (key.metaKey || key.ctrlKey)) {
      event.preventDefault()
      onStart()
    }
  }
  return (
    <View style={[styles.body, { paddingBottom: keyboardLift }]}>
      <ScrollView
        style={styles.scroll}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={styles.content}
      >
        {fields}
        {note ? (
          <View style={styles.note}>
            <Icon as="exclamationmark.triangle" size={16} color={color.accentTint} />
            <Text selectable accessibilityLiveRegion="polite" style={styles.noteText}>
              {note}
            </Text>
          </View>
        ) : null}
        <TextInput
          ref={inputRef}
          autoFocus
          multiline
          scrollEnabled={false}
          editable={!busy}
          accessibilityLabel="Task prompt"
          placeholder="What should change, and why?"
          placeholderTextColor={color.textMicro}
          value={prompt}
          onChangeText={onPrompt}
          onKeyPress={onKeyPress}
          onLayout={(event) => setPromptWidth(event.nativeEvent.layout.width)}
          onContentSizeChange={
            Platform.OS === 'web'
              ? undefined
              : (event) => measure(event.nativeEvent.contentSize.height)
          }
          style={[styles.prompt, promptHeight === undefined ? undefined : { height: promptHeight }]}
          textAlignVertical="top"
          selectionColor={color.accentTint}
        />
        {attachments.length ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.attachments}
          >
            {attachments.map((file) => (
              <View key={file.id} style={[styles.attachment, !file.previewUri && styles.document]}>
                {file.previewUri ? (
                  <Image
                    accessibilityLabel={file.name}
                    source={{ uri: file.previewUri }}
                    resizeMode="cover"
                    style={styles.preview}
                  />
                ) : (
                  <>
                    <Icon as="doc" size={18} color={color.textDim} />
                    <Text style={styles.filename} numberOfLines={2}>
                      {file.name}
                    </Text>
                  </>
                )}
                {file.state === 'uploading' ? (
                  <View style={styles.uploading}>
                    <ActivityIndicator size="small" color={color.text} />
                  </View>
                ) : null}
                {file.error ? (
                  <Text accessibilityRole="alert" style={styles.fileError} numberOfLines={3}>
                    {file.error}
                  </Text>
                ) : null}
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${file.name}`}
                  disabled={busy}
                  onPress={() => onRemoveAttachment(file.id)}
                  hitSlop={8}
                  style={styles.remove}
                >
                  <Icon as="xmark" size={10} color="#ffffff" />
                </PressableScale>
              </View>
            ))}
          </ScrollView>
        ) : null}
        {!busy && !prompt.includes(COORDINATOR_PROMPT) ? (
          <Text style={styles.tip}>
            Something big?{' '}
            <Text
              accessibilityRole="button"
              accessibilityLabel="Try adding a coordinator prompt"
              onPress={onCoordinator}
              style={styles.tipLink}
            >
              Try adding a coordinator prompt
            </Text>
          </Text>
        ) : null}
        {error ? (
          <Text selectable accessibilityRole="alert" style={styles.error}>
            {error} Your request and selections are still saved.
          </Text>
        ) : null}
      </ScrollView>
      <View
        style={[styles.toolbar, { paddingBottom: keyboardLift > 0 ? 8 : Math.max(8, bottomInset) }]}
      >
        <Glass interactive style={styles.tools}>
          <Tool symbol="photo" label="Photo library" onPress={onPhotos} disabled={busy} />
          <Tool symbol="camera" label="Camera" onPress={onCamera} disabled={busy} />
          <Tool symbol="paperclip" label="Attach file" onPress={onFiles} disabled={busy} />
        </Glass>
        {words ? (
          <Text style={styles.wordCount}>
            {words} {words === 1 ? 'word' : 'words'}
          </Text>
        ) : null}
      </View>
    </View>
  )
}

function Tool({
  symbol,
  label,
  onPress,
  disabled,
}: {
  symbol: AppIcon
  label: string
  onPress?: () => void
  disabled: boolean
}) {
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled || !onPress}
      accessibilityState={{ disabled: disabled || !onPress }}
      onPress={onPress}
      style={styles.tool}
    >
      <Icon as={symbol} size={20} color={onPress && !disabled ? color.text : color.textMicro} />
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  body: { flex: 1, minHeight: 0 },
  scroll: { flex: 1 },
  content: { paddingBottom: 16 },
  field: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
  },
  separator: {
    position: 'absolute',
    left: 16,
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.border,
  },
  fieldLabel: { fontWeight: '400', fontSize: 15, width: 68, color: color.textDim },
  fieldValue: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  value: { fontWeight: '400', fontSize: 15, color: color.text, flexShrink: 1 },
  detail: { fontWeight: '400', fontSize: 15, color: color.textDim, flexShrink: 2 },
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  noteText: { fontWeight: '400', fontSize: 13, lineHeight: 18, color: color.textDim, flex: 1 },
  prompt: {
    fontWeight: '400',
    fontSize: 17,
    lineHeight: 22,
    minHeight: 72,
    color: color.text,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 0,
  },
  attachments: { paddingHorizontal: 16, paddingTop: 12, gap: 8 },
  attachment: {
    width: 72,
    height: 72,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: color.quaternaryFill,
  },
  preview: { width: 72, height: 72 },
  document: { width: 152, padding: 12, justifyContent: 'space-between' },
  filename: { fontWeight: '400', fontSize: 13, lineHeight: 16, color: color.text },
  remove: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  uploading: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  fileError: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    fontWeight: '400',
    fontSize: 11,
    lineHeight: 14,
    padding: 4,
    paddingTop: 24,
    color: color.dangerText,
    backgroundColor: color.surface,
  },
  tip: {
    fontWeight: '400',
    paddingHorizontal: 16,
    paddingTop: 16,
    color: color.textDim,
    fontSize: 13,
    lineHeight: 18,
  },
  tipLink: { color: color.workingText },
  error: { fontWeight: '400', padding: 16, color: color.dangerText, fontSize: 13, lineHeight: 20 },
  toolbar: {
    paddingTop: 8,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  tools: { flexDirection: 'row', borderRadius: 6 },
  tool: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  wordCount: {
    fontWeight: '400',
    color: color.textMicro,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
})
