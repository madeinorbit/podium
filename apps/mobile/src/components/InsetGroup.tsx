import { Children, Fragment, isValidElement, type ReactNode } from 'react'
import { type StyleProp, StyleSheet, Text, View, type ViewStyle } from 'react-native'
import { color, font, leading, radius, sans } from '../theme/theme'

/**
 * The iOS inset-grouped list, as Settings draws it: a section header on the
 * card's own text axis, a rounded card on the grouped background, hairline
 * separators inset to the text, and an optional footer caption. Forms and
 * sheets share it so a row looks the same wherever it is edited.
 */
export function InsetGroup({
  header,
  footer,
  style,
  children,
}: {
  header?: string
  footer?: ReactNode
  style?: StyleProp<ViewStyle>
  children: ReactNode
}) {
  const rows = Children.toArray(children)
  return (
    <View style={style}>
      {header ? (
        <Text style={styles.header} accessibilityRole="header">
          {header}
        </Text>
      ) : null}
      <View style={styles.card}>
        {rows.map((row, index) => (
          <Fragment key={isValidElement(row) && row.key != null ? row.key : index}>
            {index > 0 ? <View style={styles.separator} /> : null}
            {row}
          </Fragment>
        ))}
      </View>
      {typeof footer === 'string' ? <Text style={styles.footer}>{footer}</Text> : footer}
    </View>
  )
}

/** Row metrics shared by inset-grouped forms. */
export const insetRow = StyleSheet.create({
  row: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  label: { ...sans(400), color: color.text, fontSize: font.small, flexShrink: 0 },
  value: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.small,
    flexShrink: 1,
    textAlign: 'right',
  },
  trail: {
    marginLeft: 'auto',
    flexShrink: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 6,
  },
  pressed: { backgroundColor: color.surfacePressed },
  footerError: {
    ...sans(400),
    color: color.dangerText,
    fontSize: 12,
    lineHeight: 16,
    paddingHorizontal: 12,
    paddingTop: 6,
  },
})

const styles = StyleSheet.create({
  header: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny),
    paddingHorizontal: 12,
    paddingBottom: 6,
  },
  card: {
    borderRadius: radius.insetGroup,
    borderCurve: 'continuous',
    backgroundColor: color.groupedCard,
    overflow: 'hidden',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 12,
    backgroundColor: color.border,
  },
  footer: {
    ...sans(400),
    color: color.textDim,
    fontSize: 12,
    lineHeight: 16,
    paddingHorizontal: 12,
    paddingTop: 6,
  },
})
