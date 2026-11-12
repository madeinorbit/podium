import { highlightCode } from '@podium/client-core/code-highlight'
import { useMemo } from 'react'
import { StyleSheet, Text } from 'react-native'
import { color, font, mono, sans } from '../theme/theme'
import { HighlightedCode } from './HighlightedCode'

/** One clamped native text layout, with inline syntax leaves inside it. A shell
 *  command reads as code (mono, highlighted); edits and reads are prose titles
 *  in the sans face, as the board's opened fold draws them. */
export function ToolDescription({ toolName, command }: { toolName?: string; command: string }) {
  const bash = toolName === 'Bash'
  const tokens = useMemo(() => (bash ? highlightCode(command, 'bash') : null), [bash, command])
  return (
    <Text
      style={[styles.description, bash ? styles.command : styles.title]}
      numberOfLines={1}
      ellipsizeMode="tail"
    >
      {tokens ? <HighlightedCode tokens={tokens} /> : command}
    </Text>
  )
}

const styles = StyleSheet.create({
  description: {
    flex: 1,
    minWidth: 0,
    color: color.textFaint,
    fontSize: font.tiny,
  },
  command: {
    ...mono(400),
  },
  title: {
    ...sans(400),
  },
})
