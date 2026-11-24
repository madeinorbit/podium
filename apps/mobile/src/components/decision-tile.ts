import { StyleSheet } from 'react-native'
import { color, radius, sans, space } from '../theme/theme'

/** Approved ChatAsk tile geometry, shared by pinned asks and session offers. */
export const decisionTile = StyleSheet.create({
  card: {
    backgroundColor: color.card,
    borderRadius: radius.card,
    padding: space.md,
    gap: space.sm,
  },
  signal: { borderWidth: 1, borderColor: color.needsYouBorder },
  title: { ...sans(600), color: color.text, fontSize: 15, lineHeight: 20 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
  button: {
    minHeight: 32,
    maxWidth: '100%',
    borderRadius: radius.control,
    paddingHorizontal: space.md,
    paddingVertical: 6,
    justifyContent: 'center',
    backgroundColor: color.fill,
  },
  buttonText: { ...sans(500), color: color.text, fontSize: 14, lineHeight: 20 },
})
