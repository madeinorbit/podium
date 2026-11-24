import { useState } from 'react'
import { StyleSheet, TextInput } from 'react-native'
import { color, font, leading, sans } from '../../theme/theme'
import { BottomSheet } from '../BottomSheet'
import { FormSheetBar } from '../compose/FormSheetBar'
import { InsetGroup } from '../InsetGroup'

/**
 * One line of text, asked for from a sheet [POD-724].
 *
 * The desktop reaches for `window.prompt` when it flags a task for a human. There
 * is no such thing on a phone, and inventing a full-screen form for one optional
 * sentence would be heavier than the decision it serves — so this is the shared
 * {@link BottomSheet} with an iOS sheet bar (Cancel, title, confirm) over one
 * inset-grouped field. Empty is a legitimate answer: flagging with no question
 * is what the desktop does when the operator dismisses the prompt's text, and
 * the confirm stays enabled to say so.
 */
export function PromptSheet({
  visible,
  title,
  hint,
  placeholder,
  confirmLabel,
  initialValue = '',
  preserveEdits = false,
  multiline = true,
  onConfirm,
  onClose,
}: {
  visible: boolean
  title: string
  hint?: string
  placeholder: string
  confirmLabel: string
  /** Seed editable prompts such as Rename; omitted for compose-new prompts. */
  initialValue?: string
  /** Live record updates may reseed untouched text, but keep the operator's draft. */
  preserveEdits?: boolean
  multiline?: boolean
  onConfirm: (value: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState(initialValue)
  // A reopened compose prompt must not carry its prior text; an edit prompt
  // starts from the current value each time it opens. Seed synchronously
  // during render (not in an effect) so the first committed frame already
  // shows the seeded text: an effect leaves one empty frame that a fast
  // confirm — autofill, a test driver, a double-tap — can observe and submit.
  const [seed, setSeed] = useState({ visible, initial: initialValue })
  if (visible && (!seed.visible || seed.initial !== initialValue)) {
    setSeed({ visible: true, initial: initialValue })
    if (!seed.visible || !preserveEdits || value === seed.initial) setValue(initialValue)
  } else if (visible !== seed.visible) {
    setSeed({ visible, initial: initialValue })
  }

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      mode="fit"
      grouped
      contentStyle={styles.content}
      head={
        <FormSheetBar
          title={title}
          confirmLabel={confirmLabel}
          canConfirm
          busy={false}
          onCancel={onClose}
          onConfirm={() => {
            onClose()
            onConfirm(value.trim())
          }}
        />
      }
    >
      <InsetGroup footer={hint}>
        <TextInput
          value={value}
          onChangeText={setValue}
          accessibilityLabel={title}
          placeholder={placeholder}
          placeholderTextColor={color.textFaint}
          multiline={multiline}
          autoFocus
          returnKeyType={multiline ? 'default' : 'done'}
          onSubmitEditing={
            multiline
              ? undefined
              : () => {
                  onClose()
                  onConfirm(value.trim())
                }
          }
          clearButtonMode={multiline ? 'never' : 'while-editing'}
          style={[styles.field, multiline ? styles.multiline : styles.singleLine]}
        />
      </InsetGroup>
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
  },
  field: {
    ...sans(400),
    color: color.text,
    fontSize: font.body,
    paddingHorizontal: 12,
  },
  singleLine: { minHeight: 44, paddingVertical: 10 },
  multiline: {
    minHeight: 96,
    lineHeight: leading(font.body, 'prose'),
    textAlignVertical: 'top',
    paddingTop: 11,
    paddingBottom: 11,
  },
})
