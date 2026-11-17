import {
  Children,
  createContext,
  Fragment,
  isValidElement,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  Animated,
  StyleSheet,
  TextInput,
  type TextProps,
  useColorScheme,
  useWindowDimensions,
  View,
} from 'react-native'
import { useReduceMotion } from '../../hooks/useReduceMotion'
import { alpha } from '../../theme/mix'
import { color, font, leading, radius, sans, space, spring } from '../../theme/theme'
import { useLiveInk } from '../../theme/use-live-ink'
import { Icon } from '../Icon'
import { ChevronRight } from '../icons'
import { PressableScale } from '../PressableScale'
import { DetailText as Text } from './DetailText'
import { useDetailLayout } from './detail-type'

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

/** A secondary label within a grouped property row. */
export function MachineLabel({ children }: { children: ReactNode }) {
  return <Text style={styles.machine}>{children}</Text>
}

const ReferenceRows = createContext(false)

/** Reference disclosures share one Settings-style inset group. */
export function ReferenceGroup({ children }: { children: ReactNode }) {
  const scheme = useColorScheme()
  return (
    <ReferenceRows.Provider value={true}>
      <View style={styles.referenceGroup} testID="issue-reference-group">
        <View key={scheme} pointerEvents="none" style={styles.referenceGround} />
        {Children.toArray(children).map((child, index) => (
          <Fragment key={isValidElement(child) ? child.key : String(child)}>
            {index > 0 ? <View style={styles.referenceSeparator} /> : null}
            {child}
          </Fragment>
        ))}
      </View>
    </ReferenceRows.Provider>
  )
}

/** Group headings align with the content inset of plain cards. */
export function SectionHeading({
  label,
  count,
  right,
}: {
  label: string
  count?: string | undefined
  right?: ReactNode
}) {
  const singleWord = /^\S+$/.test(label.trim())
  return (
    <View style={styles.heading} accessibilityRole="header">
      <Text
        style={styles.title}
        numberOfLines={singleWord ? 1 : undefined}
        adjustsFontSizeToFit={singleWord}
        minimumFontScale={0.85}
        ellipsizeMode="tail"
      >
        {label}
      </Text>
      {count ? <Text style={styles.count}>{count}</Text> : null}
      <View style={styles.spacer} />
      {right}
    </View>
  )
}

/** An inset group for content that should be readable without opening a fold. */
export function DetailSection({
  label,
  children,
  testID,
}: {
  label: string
  children: ReactNode
  testID?: string
}) {
  const scheme = useColorScheme()
  return (
    <View testID={testID}>
      <SectionHeading label={label} />
      <View style={styles.contentGroup}>
        {/* Refresh the cached native layer while the editor and text stay mounted. */}
        <View key={scheme} pointerEvents="none" style={styles.contentGround} />
        {children}
      </View>
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
  const { size, accessorySize } = useDetailLayout()
  const grouped = useContext(ReferenceRows)
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
    <View style={[styles.disclosure, grouped && styles.groupedDisclosure]} testID={testID}>
      <PressableScale
        accessibilityRole="button"
        // `aria-expanded` beside `accessibilityState`: react-native-web 0.21 reads
        // only the former, so the web build announced no state at all. [POD-1664]
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        accessibilityLabel={label}
        onPress={onToggle}
        scaleTo={0.995}
        style={({ pressed }) => [
          styles.discHead,
          grouped && styles.groupedInset,
          pressed && styles.discHeadPressed,
        ]}
      >
        <View style={styles.discRow}>
          <View style={styles.discLabel}>
            <Text style={styles.discTitle}>{label}</Text>
          </View>
          {count ? <Text style={styles.count}>{count}</Text> : null}
          <Animated.View
            style={[
              styles.chevron,
              {
                width: accessorySize(14),
                height: size(leading(font.body)),
                transform: [{ rotate }],
              },
            ]}
          >
            <Icon as={ChevronRight} size={accessorySize(14)} color={color.textFaint} />
          </Animated.View>
        </View>
        {/* Under the row, not in its flex label: inside the natively hosted page a
          flex-row text child kept its one-line width at AX5, clipping the
          subtitle and pushing the chevron past the card edge. */}
        {hint ? (
          <Text lineBreakStrategyIOS="standard" style={styles.hint}>
            {hint}
          </Text>
        ) : null}
      </PressableScale>
      {open ? (
        <View style={[styles.discBody, grouped && styles.groupedBody]}>{children}</View>
      ) : null}
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
  dynamicTypeRamp,
}: {
  value: string
  placeholder: string
  ariaLabel: string
  busy: boolean
  multiline?: boolean
  onCommit: (value: string) => void
  render?: (text: string) => ReactNode
  textStyle?: TextProps['style']
  dynamicTypeRamp?: TextProps['dynamicTypeRamp']
}) {
  const [editing, setEditing] = useState(false)
  const { fontScale } = useWindowDimensions()
  const [draft, setDraft] = useState(value)
  const ink = useLiveInk(
    (StyleSheet.flatten([styles.editText, textStyle])?.color ?? color.body) as string,
  )

  if (!editing) {
    const filled = value.trim().length > 0
    return (
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={ariaLabel}
        accessibilityValue={{ text: filled ? value : placeholder }}
        accessibilityHint="Opens a text editor"
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
          <Text
            dynamicTypeRamp={dynamicTypeRamp}
            lineBreakStrategyIOS="standard"
            style={[styles.editText, textStyle, { color: ink }, !filled && styles.editPlaceholder]}
          >
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
        key={fontScale}
        value={draft}
        onChangeText={setDraft}
        accessibilityLabel={ariaLabel}
        placeholder={placeholder}
        placeholderTextColor={color.textMicro}
        multiline={multiline}
        lineBreakStrategyIOS="standard"
        autoFocus
        editable={!busy}
        style={[styles.field, textStyle, { color: ink }, multiline && styles.fieldMultiline]}
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
  // Card-width, with the native inset-group radius and text column (20pt in).
  referenceGroup: {
    borderRadius: radius.insetGroup,
    borderCurve: 'continuous',
    overflow: 'hidden',
    backgroundColor: color.groupedCard,
  },
  referenceGround: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: color.groupedCard,
  },
  referenceSeparator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 20,
    backgroundColor: color.hairline,
  },
  groupedDisclosure: { borderRadius: 0, backgroundColor: 'transparent' },
  groupedInset: { paddingLeft: 20, paddingRight: 16 },
  groupedBody: { marginHorizontal: 20 },
  machine: {
    ...sans(400),
    fontSize: font.tiny,
    color: color.textDim,
  },
  // Section names: the iOS board's sentence-case group header, 13pt semibold.
  title: {
    ...sans(600),
    color: color.textDim,
    fontSize: font.tiny,
    flexShrink: 1,
  },
  count: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.tiny,
    flexShrink: 1,
    fontVariant: ['tabular-nums'],
  },
  hint: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.tiny,
    alignSelf: 'stretch',
  },
  // On the card axis: 12pt in, the chevron in a 14pt gutter, the name after it.
  heading: {
    minHeight: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingLeft: 16,
    paddingRight: 16,
    marginBottom: space.sm,
  },
  contentGroup: {
    padding: space.md,
    gap: space.lg,
    borderRadius: radius.card,
    borderCurve: 'continuous',
  },
  contentGround: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: radius.card,
    borderCurve: 'continuous',
    backgroundColor: color.groupedCard,
  },
  disclosure: {
    borderRadius: radius.card,
    borderCurve: 'continuous',
    overflow: 'hidden',
    backgroundColor: color.groupedCard,
  },
  spacer: { flex: 1 },
  chevron: { alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start' },
  discHead: {
    minHeight: 44,
    justifyContent: 'center',
    gap: space.xs,
    paddingHorizontal: 16,
    paddingVertical: space.md,
  },
  discRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  discLabel: { flex: 1, minWidth: 0 },
  discTitle: { ...sans(400), color: color.text, fontSize: font.body },
  discHeadPressed: {
    backgroundColor: alpha(color.surface, 0.7),
  },
  discBody: {
    marginHorizontal: 16,
    paddingVertical: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
  },
  editTarget: {
    marginHorizontal: -space.sm,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.control,
    minHeight: 44,
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
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
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
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.control,
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
