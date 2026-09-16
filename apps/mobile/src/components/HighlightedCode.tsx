import type { CodeToken } from '@podium/client-core/code-highlight'
import { Text } from 'react-native'
import { syntaxColor } from '../theme/syntax'

/** Nested native Text keeps source selectable without HTML or a WebView. */
export function HighlightedCode({ tokens }: { tokens: readonly CodeToken[] }) {
  return tokens.map((token, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: immutable token leaves are positional within a memoized block
    <Text key={index} style={{ color: syntaxColor(token.scope) }}>
      {token.text}
    </Text>
  ))
}
