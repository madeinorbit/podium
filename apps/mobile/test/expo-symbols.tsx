import { View } from 'react-native'

/** Unit tests exercise the controls around icons, not the native glyph view. */
export function SymbolView({ size = 24 }: { size?: number }) {
  return <View style={{ width: size, height: size }} />
}
