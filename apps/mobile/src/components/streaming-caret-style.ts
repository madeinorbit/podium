import { StyleSheet } from 'react-native'
import { color, font, mono } from '../theme/theme'

export const caretStyle = StyleSheet.create({
  caret: { ...mono(700), color: color.accentTint, fontSize: font.small, marginTop: 2 },
}).caret
