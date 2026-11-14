import { COORDINATOR_PROMPT, countWords } from '@podium/client-core/new-task'
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Image,
  Keyboard,
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
    <ComposeMenu
      label={label}
      items={items}
      disabled={disabled}
      style={{ alignSelf: 'stretch', minHeight: 44 }}
    >
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
  promptReady = true,
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
  topInset = 0,
  keyboardLift = 0,
  trailingAction,
}: {
  fields: ReactNode
  prompt: string
  onPrompt: (prompt: string) => void
  promptRef?: RefObject<TextInput | null>
  promptReady?: boolean
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
  topInset?: number
  keyboardLift?: number
  trailingAction?: ReactNode
}) {
  const words = countWords(prompt)
  const ownRef = useRef<TextInput>(null)
  const inputRef = promptRef ?? ownRef
  const scrollRef = useRef<ScrollView>(null)
  const keyboardVisible = keyboardLift > 0
  const wasKeyboardVisible = useRef(keyboardVisible)
  const [promptHeight, setPromptHeight] = useState<number>()
  const [promptWidth, setPromptWidth] = useState(0)
  const [bodyHeight, setBodyHeight] = useState(0)
  const [toolbarHeight, setToolbarHeight] = useState(0)
  const [headerHeight, setHeaderHeight] = useState(0)
  const [footerHeight, setFooterHeight] = useState(0)
  const viewportHeight = Math.max(0, bodyHeight - keyboardLift - toolbarHeight)
  const maxPromptHeight = viewportHeight
    ? Math.max(72, viewportHeight - topInset - headerHeight - footerHeight - 16)
    : undefined
  useEffect(() => {
    const dismissed = wasKeyboardVisible.current && !keyboardVisible
    wasKeyboardVisible.current = keyboardVisible
    if (!dismissed) return
    // Wait for the expanded viewport, then undo the focus scroll. The explicit
    // header inset keeps UIKit's sheet adjustment from leaving the rows at y=0.
    const frame = requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ y: -topInset, animated: false })
    })
    return () => cancelAnimationFrame(frame)
  }, [keyboardVisible, topInset])
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
    <View
      testID="compose-body"
      style={[styles.body, { paddingBottom: keyboardLift }]}
      onLayout={(event) => setBodyHeight(event.nativeEvent.layout.height)}
    >
      <ScrollView
        ref={scrollRef}
        testID="compose-scroll"
        style={[styles.scroll, { maxHeight: bodyHeight ? viewportHeight : undefined }]}
        automaticallyAdjustContentInsets={false}
        automaticallyAdjustKeyboardInsets={false}
        contentInsetAdjustmentBehavior="never"
        contentInset={{ top: topInset, bottom: 0, left: 0, right: 0 }}
        contentOffset={{ x: 0, y: -topInset }}
        scrollIndicatorInsets={{ top: topInset }}
        // SwiftUI menus handle touches outside RN's responder system. With
        // "handled", ScrollView treats them as background taps and blurs.
        keyboardShouldPersistTaps="always"
        keyboardDismissMode="interactive"
        contentContainerStyle={styles.content}
      >
        <View
          testID="compose-fields"
          onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)}
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
        </View>
        {promptReady ? (
          <TextInput
            ref={inputRef}
            autoFocus
            multiline
            scrollEnabled={maxPromptHeight !== undefined && (promptHeight ?? 0) >= maxPromptHeight}
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
            // Native must keep its intrinsic height. Feeding its last measurement
            // back as height caps UIKit's next measurement and clips later lines.
            style={[
              styles.prompt,
              { maxHeight: maxPromptHeight },
              Platform.OS === 'web' && promptHeight !== undefined
                ? { height: Math.min(promptHeight, maxPromptHeight ?? promptHeight) }
                : undefined,
            ]}
            textAlignVertical="top"
            selectionColor={color.accentTint}
          />
        ) : (
          <View testID="compose-prompt-pending" style={[styles.prompt, { height: 72 }]} />
        )}
        <View
          testID="compose-footer"
          onLayout={(event) => setFooterHeight(event.nativeEvent.layout.height)}
        >
          {attachments.length ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="always"
              contentContainerStyle={styles.attachments}
            >
              {attachments.map((file) => (
                <View
                  key={file.id}
                  style={[styles.attachment, !file.previewUri && styles.document]}
                >
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
                    <View pointerEvents="none" style={styles.removeBadge}>
                      <Icon as="xmark.circle.fill" size={20} color={color.text} />
                    </View>
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
        </View>
        <PressableScale
          testID="compose-dismiss-keyboard"
          accessible={false}
          onPress={Keyboard.dismiss}
          style={styles.dismissArea}
        />
      </ScrollView>
      <View
        testID="compose-toolbar"
        onLayout={(event) => setToolbarHeight(event.nativeEvent.layout.height)}
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
        {trailingAction}
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
  // The body owns keyboard clearance; the measured bar owns the remaining
  // bottom inset. Keep prompt sizing inside that same bounded viewport.
  scroll: { flex: 1, minHeight: 0, overflow: 'hidden' },
  content: { flexGrow: 1, paddingBottom: 16 },
  dismissArea: { flex: 1, minHeight: 0 },
  field: {
    width: '100%',
    alignSelf: 'stretch',
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
  // A minimum, not a width: at accessibility sizes a fixed 68pt column broke
  // "Project" and "Machine" mid-word. The value side shrinks instead.
  fieldLabel: {
    fontWeight: '400',
    fontSize: 15,
    minWidth: 68,
    flexShrink: 0,
    color: color.textDim,
  },
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
    top: 0,
    right: 0,
    width: 44,
    height: 44,
    paddingTop: 4,
    paddingRight: 4,
    alignItems: 'flex-end',
  },
  removeBadge: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: color.groupedCard,
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
    flexShrink: 0,
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
