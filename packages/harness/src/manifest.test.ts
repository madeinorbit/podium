import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeRecordToItems, decodeCursor, fileIdFor } from './store/index'
import { expect, it } from 'vitest'
import { fileTranscript } from './manifest'

it('file sources share the native session namespace across paths and repeated parses', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'manifest-namespace-'))
  try {
    const bytes = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } })}\n`
    const paths = [join(dir, 'live.jsonl'), join(dir, 'mirror.jsonl')] as const
    for (const path of paths) await writeFile(path, bytes)
    const transcript = fileTranscript(
      async ({ pathHint }) => (pathHint ? [pathHint] : []),
      claudeRecordToItems,
    )
    const read = async (pathHint: string, resumeValue?: string) =>
      (await transcript.sourceFor({ cwd: dir, pathHint, resumeValue })).readSlice({
        direction: 'before',
        limit: 10,
      })
    const first = await read(paths[0], 'native-session')
    expect(first.items).toHaveLength(1)
    expect(decodeCursor(first.items[0]?.cursor ?? '')?.fileId).toBe(fileIdFor('native-session'))
    expect(first.items[0]?.id).toBe(first.items[0]?.cursor)
    expect(await read(paths[0], 'native-session')).toEqual(first)
    expect(await read(paths[1], 'native-session')).toEqual(first)
    expect((await read(paths[0])).items).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
