import {
  type ChatBlock,
  resolveToolEdit,
  toolEditLines,
  toolVerdict,
} from '@podium/client-core/values'
import { StyleSheet, Text, View } from 'react-native'
import { color, mono, radius, sans, space } from '../theme/theme'

/** The recorded output or edit, capped only in the inline preview. */
export function ToolCallContent({
  block,
  preview = false,
}: {
  block: ChatBlock
  preview?: boolean
}) {
  const { item } = block
  const edit = resolveToolEdit(item)
  const result = block.result ?? item.toolResult
  const input = item.toolInput ?? item.toolInputJson
  const diff = edit ? toolEditLines(edit, preview ? 6 : Number.POSITIVE_INFINITY) : undefined
  const output = result ?? 'No output recorded.'
  return (
    <View style={styles.content}>
      {!preview && edit && result && toolVerdict(result, item.toolEffects) === 'err' ? (
        <Text selectable style={[styles.output, styles.removed]}>
          {result}
        </Text>
      ) : null}
      {!preview && input && !edit ? (
        <>
          <Text style={styles.label}>Input</Text>
          <Text selectable style={styles.output}>
            {input}
          </Text>
          <Text style={styles.label}>Output</Text>
        </>
      ) : null}
      {diff ? (
        <Text selectable={!preview} style={styles.output}>
          {diff.lines.map((line, index) => (
            <Text
              // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have positional identity.
              key={index}
              style={
                line.kind === 'add'
                  ? styles.added
                  : line.kind === 'del'
                    ? styles.removed
                    : undefined
              }
            >
              {`${line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : line.kind === 'hunk' ? '@@ ' : ' '}${line.text}\n`}
            </Text>
          ))}
          {!preview && diff.omitted > 0 ? `${diff.omitted} more lines were not recorded.` : null}
        </Text>
      ) : (
        <Text selectable={!preview} style={styles.output}>
          {preview ? output.split('\n').slice(0, 6).join('\n') : output}
        </Text>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  content: {
    backgroundColor: color.quaternaryFill,
    borderRadius: radius.control,
    padding: space.sm,
    gap: space.sm,
  },
  label: { ...sans(600), color: color.textDim, fontSize: 13, lineHeight: 16 },
  output: { ...mono(400), color: color.textDim, fontSize: 12, lineHeight: 16 },
  added: { color: color.workingText },
  removed: { color: color.dangerText },
})
