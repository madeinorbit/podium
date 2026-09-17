import { highlightCode } from '@podium/client-core/code-highlight'
import { useMemo } from 'react'
import { StyleSheet, Text } from 'react-native'
import { color, font, mono } from '../theme/theme'
import { HighlightedCode } from './HighlightedCode'

/** One clamped native text layout, with inline syntax leaves inside it. */
export function ToolDescription({ toolName, command }: { toolName?: string; command: string }) {
  const bash = toolName === 'Bash'
  const tokens = useMemo(() => (bash ? highlightCode(command, 'bash') : null), [bash, command])
  return (
    <Text style={styles.description} numberOfLines={1} ellipsizeMode="tail">
      {tokens ? <HighlightedCode tokens={tokens} /> : command}
    </Text>
  )
}

const styles = StyleSheet.create({
  description: {
    ...mono(400),
    flex: 1,
    minWidth: 0,
    color: color.textFaint,
    fontSize: font.tiny,
  },
})
