import { ChevronRight } from '../icons'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Animated, StyleSheet, Text, TextInput, View } from 'react-native'
import { useReduceMotion } from '../../hooks/useReduceMotion'
import { alpha } from '../../theme/mix'
import {
  color,
  font,
  leading,
  mono,
  monoLabel,
  radius,
  sans,
  space,
  spring,
} from '../../theme/theme'
import { Icon } from '../Icon'
import { PressableScale } from '../PressableScale'

/**
 * The task page's shared furniture [POD-724] — the four things every section on
 * it needs, so eight section modules do not each invent their own.
 *
 * The desktop page's chrome is a heading, a fold and an inline editor; the phone
 * needs the same three plus a keyboard-safe way to commit an edit. That last one
 * is the only genuine divergence: the desktop commits a field on BLUR, which is
 * unambiguous with a mouse and is not on a touch screen — swiping the keyboard
 * away, tapping a link, or the system stealing focus all blur a field, and none
 * of them mean "save". So an editor here opens with an explicit Cancel/Save pair
 * and commits on nothing else.
 */

/** Mono micro-label — the page's machine voice (section names, field names). */
export function MachineLabel({ children }: { children: ReactNode }) {
  return <Text style={styles.machine}>{children}</Text>
}

/**
 * A section heading: mono label, an optional count, a hairline that takes the
 * remaining width, and an optional trailing control. Same grammar as the
 * desktop's `SectionHeading` and the phone's own list headers, so a page made of
 * eight sections still reads as one document.
 */
export function SectionHeading({
  label,
  count,
  right,
}: {
  label: string
  count?: string | undefined
  right?: ReactNode
}) {
  return (
    <View style={styles.heading}>
      <Text style={styles.machine}>{label}</Text>
      {count ? <Text style={styles.count}>{count}</Text> : null}
      <View style={styles.rule} />
      {right}
    </View>
  )
}

/**
 * A fold. Used for everything the page holds but does not lead with — the agent
 * brief and the properties block.
 *
 * The chevron rotates on a spring and is the only motion; Reduce Motion turns
 * that into an instant flip rather than a slower one, because a rotation that
 * merely takes longer is still a rotation.
 */
export function Disclosure({
  label,
  hint,
  count,
  open,
  onToggle,
  children,
  testID,
}: {
  label: string
  /** A few words on why this is folded, in the faintest ink on the page. */
  hint?: string
  count?: string | undefined
  open: boolean
  onToggle: () => void
  children: ReactNode
  testID?: string
}) {
  const reduceMotion = useReduceMotion()
  const spin = useRef(new Animated.Value(open ? 1 : 0)).current
  useEffect(() => {
    if (reduceMotion) {
      spin.setValue(open ? 1 : 0)
      return
    }
    Animated.spring(spin, {
      toValue: open ? 1 : 0,
      useNativeDriver: true,
      ...spring.snappy,
    }).start()
  }, [open, reduceMotion, spin])
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '90deg'] })
  return (
    <View testID={testID}>
      <PressableScale
        accessibilityRole="button"
        // `aria-expanded` beside `accessibilityState`: react-native-web 0.21 reads
        // only the former, so the web build announced no state at all. [POD-1664]
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        accessibilityLabel={label}
        onPress={onToggle}
        scaleTo={0.995}
        style={({ pressed }) => [styles.discHead, pressed && styles.discHeadPressed]}
      >
        <Animated.View style={{ transform: [{ rotate }] }}>
          <Icon as={ChevronRight} size={13} color={color.textFaint} />
        </Animated.View>
        <Text style={styles.machine}>{label}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
        {count ? <Text style={[styles.count, styles.countRight]}>{count}</Text> : null}
      </PressableScale>
      {open ? <View style={styles.discBody}>{children}</View> : null}
    </View>
  )
}

/**
 * Tap-to-edit text. At rest it is the text itself (or a placeholder in italic
 * ink); tapped, it becomes a field with Cancel and Save.
 *
 * `render` lets a caller draw the resting state richly — the description renders
 * as markdown — while the editor always edits the raw source, which is the only
 * honest thing to put in a text field.
 */
export function InlineEditable({
  value,
  placeholder,
  ariaLabel,
  busy,
  multiline = true,
  onCommit,
  render,
  textStyle,
}: {
  value: string
  placeholder: string
  ariaLabel: string
  busy: boolean
  multiline?: boolean
  onCommit: (value: string) => void
  render?: (text: string) => ReactNode
  textStyle?: object
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  if (!editing) {
    const filled = value.trim().length > 0
    return (
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={filled ? `${ariaLabel} — edit` : ariaLabel}
        onPress={() => {
          setDraft(value)
          setEditing(true)
        }}
        scaleTo={0.997}
        style={({ pressed }) => [styles.editTarget, pressed && styles.editTargetPressed]}
      >
        {filled && render ? (
          render(value)
        ) : (
          <Text style={[styles.editText, textStyle, !filled && styles.editPlaceholder]}>
            {filled ? value : placeholder}
          </Text>
        )}
      </PressableScale>
    )
  }

  const dirty = draft !== value
  return (
    <View style={styles.editor}>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        accessibilityLabel={ariaLabel}
        placeholder={placeholder}
        placeholderTextColor={color.textMicro}
        multiline={multiline}
        autoFocus
        editable={!busy}
        style={[styles.field, textStyle, multiline && styles.fieldMultiline]}
      />
      <View style={styles.editorBar}>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          onPress={() => setEditing(false)}
          style={({ pressed }) => [styles.editBtn, pressed && styles.editBtnPressed]}
        >
          <Text style={styles.editBtnText}>Cancel</Text>
        </PressableScale>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Save"
          accessibilityState={{ disabled: busy || !dirty }}
          disabled={busy || !dirty}
          onPress={() => {
            setEditing(false)
            onCommit(draft)
          }}
          style={({ pressed }) => [
            styles.editBtn,
            styles.editSave,
            (busy || !dirty) && styles.editBtnMuted,
            pressed && styles.editBtnPressed,
          ]}
        >
          <Text style={[styles.editBtnText, styles.editSaveText]}>Save</Text>
        </PressableScale>
      </View>
    </View>
  )
}

/** The page's inline error line — a failed mutation says so where it happened
 *  and in the words the server used, never a swallowed console log. */
export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <Text style={styles.error} accessibilityRole="alert">
      {message}
    </Text>
  )
}

const styles = StyleSheet.create({
  machine: {
    ...monoLabel(),
    color: color.label,
  },
  count: {
    ...mono(600),
    color: color.textFaint,
    fontSize: font.micro,
  },
  countRight: {
    marginLeft: 'auto',
  },
  hint: {
    ...sans(400),
    color: color.textMicro,
    fontSize: font.micro,
  },
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingBottom: space.sm,
  },
  rule: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.hairline,
  },
  discHead: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.sm,
    marginHorizontal: -space.sm,
    borderRadius: radius.md,
  },
  discHeadPressed: {
    backgroundColor: alpha(color.surface, 0.7),
  },
  discBody: {
    paddingTop: space.xs,
  },
  editTarget: {
    marginHorizontal: -space.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    borderRadius: radius.md,
    minHeight: 34,
    justifyContent: 'center',
  },
  editTargetPressed: {
    backgroundColor: alpha(color.surface, 0.7),
  },
  editText: {
    ...sans(400),
    color: color.body,
    fontSize: font.body,
    lineHeight: leading(font.body, 'prose'),
  },
  editPlaceholder: {
    color: color.textMicro,
    fontStyle: 'italic',
  },
  editor: {
    gap: space.sm,
  },
  field: {
    ...sans(400),
    color: color.text,
    fontSize: font.body,
    lineHeight: leading(font.body, 'prose'),
    backgroundColor: color.bgSunken,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
  },
  fieldMultiline: {
    minHeight: 112,
    textAlignVertical: 'top',
  },
  editorBar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: space.sm,
  },
  editBtn: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  editBtnPressed: {
    opacity: 0.8,
  },
  editBtnMuted: {
    opacity: 0.45,
  },
  editSave: {
    // The single primary action of this region — the one place the page spends
    // the accent while an editor is open (The Signal Rule).
    backgroundColor: color.accent,
    borderColor: color.accent,
  },
  editBtnText: {
    ...sans(600),
    color: color.body,
    fontSize: font.small,
  },
  editSaveText: {
    color: color.onAccent,
  },
  error: {
    ...sans(400),
    color: color.dangerText,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny),
  },
})
