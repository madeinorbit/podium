/** Refresh the shape-only corpus without retaining prompt, code, path or output values.
 * bun packages/transcript/scripts/capture-claude-shapes.ts <corpus-directory> <output.json>
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [directory, output] = process.argv.slice(2)
if (!directory || !output) throw new Error('Expected corpus directory and output JSON path')
const files = readdirSync(directory).filter((file) => file.endsWith('.jsonl'))
if (!files.length) throw new Error('Corpus contains no JSONL files')
const shapes = new Map<string, number>()
let records = 0
for (const file of files) {
  for (const line of readFileSync(join(directory, file), 'utf8').split('\n').filter(Boolean)) {
    const record = JSON.parse(line)
    const shape = {
      type: record.type,
      ...(record.type === 'attachment' ? { attachment: { type: record.attachment?.type } } : {}),
      ...(record.type === 'system' ? { subtype: record.subtype } : {}),
      ...(record.toolUseResult &&
      typeof record.toolUseResult === 'object' &&
      !Array.isArray(record.toolUseResult)
        ? {
            toolUseResult: Object.fromEntries(
              Object.keys(record.toolUseResult)
                .sort()
                .map((key) => [key, null]),
            ),
          }
        : {}),
    }
    const key = JSON.stringify(shape)
    shapes.set(key, (shapes.get(key) ?? 0) + 1)
    records++
  }
}
writeFileSync(
  output,
  `${JSON.stringify({ provenance: { date: new Date().toISOString().slice(0, 10), transcripts: files.length, records, description: 'Shape-only projection of real Claude JSONL transcripts; values omitted, key presence and multiplicity retained.' }, shapes: [...shapes].map(([record, count]) => ({ count, record: JSON.parse(record) })) }, null, 2)}\n`,
)
