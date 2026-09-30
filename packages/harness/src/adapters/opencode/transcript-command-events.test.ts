import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { OpencodeMessagePartRow } from './transcript.js'
import { opencodePromptTextMatches, opencodeRowsToItems } from './transcript.js'

// Native frames and full SQLite snapshots from the scratch-HOME/fake-model
// OpenCode 1.18.33 reconnect and crash measurement (2026-09-30, POD-4906).
const evidence = new URL(
  '../../../../../docs/measurements/pod-4906-opencode-command-events/',
  import.meta.url,
)
type MessageRow = {
  id: string
  session_id: string
  time_created: number
  time_updated: number
  data: { role: string; parentID?: string; time: { created: number; completed?: number } }
}
type PartRow = {
  id: string
  message_id: string
  session_id: string
  time_created: number
  time_updated: number
  data: Record<string, unknown>
}
type Snapshot = { tables: { message: MessageRow[]; part: PartRow[]; event: { type: string }[] } }
type Frame = {
  type: string
  properties?: {
    name?: string
    arguments?: string
    messageID?: string
    info?: { id: string; time: { completed?: number } }
  }
}
type TimelineEntry = {
  at: number
  kind: string
  label?: string
  name?: string
  expansionId?: string
  assistantId?: string
  status?: number
  frame?: Frame
}
const read = (name: string): string => readFileSync(new URL(name, evidence), 'utf8')
const timeline: TimelineEntry[] = read('timeline.jsonl')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))
const final: Snapshot = JSON.parse(read('final.json'))
const beforeKill: Snapshot = JSON.parse(read('crash-before-kill.json'))
const restart: Snapshot = JSON.parse(read('restart.json'))
const hooks: {
  hook: string
  input: { type?: string; properties?: { arguments?: string; messageID?: string } }
}[] = JSON.parse(read('hooks.jsonl.json'))

function message(snapshot: Snapshot, id: string | undefined): MessageRow {
  const row = snapshot.tables.message.find((row) => row.id === id)
  if (!row) throw new Error(`Missing measured message ${id}`)
  return row
}
function rows(snapshot: Snapshot, native: MessageRow): OpencodeMessagePartRow[] {
  return snapshot.tables.part
    .filter((part) => part.message_id === native.id)
    .map((part) => ({
      messageId: native.id,
      partId: part.id,
      sessionId: native.session_id,
      timeCreated: part.time_created,
      timeUpdated: part.time_updated,
      messageData: JSON.stringify(native.data),
      partData: JSON.stringify(part.data),
    }))
}
function command(label: string): TimelineEntry {
  const entry = timeline.find(
    (entry) =>
      entry.kind === 'sse' && entry.label === label && entry.frame?.type === 'command.executed',
  )
  if (!entry) throw new Error(`Missing measured command on ${label}`)
  return entry
}
const completed = command('live.v1')
const completedReply = message(final, completed.frame?.properties?.messageID)
const expansion = message(final, completedReply.data.parentID)

describe('OpenCode command provenance measurement', () => {
  it('links the live event to the expansion only through its assistant reply', () => {
    expect(completed.frame?.properties).toMatchObject({ name: 'probe', arguments: 'completed' })
    expect(completedReply.data.role).toBe('assistant')
    expect(expansion.data.role).toBe('user')
    const native = rows(final, expansion)
    expect(native).toHaveLength(1)
    expect(JSON.parse(native[0]!.partData)).toEqual({
      type: 'text',
      text: 'S9 CMD TEMPLATE expanded with: completed',
    })
    expect(opencodeRowsToItems(native)).toEqual([
      expect.objectContaining({
        role: 'user',
        promptEntry: true,
        text: 'S9 CMD TEMPLATE expanded with: completed',
      }),
    ])
    expect(
      opencodePromptTextMatches('/probe completed', opencodeRowsToItems(native)[0]?.text ?? ''),
    ).toBe(false)
  })

  it('receives the command marker after the native completed reply frame', () => {
    const completedMessage = timeline.find(
      (entry) =>
        entry.kind === 'sse' &&
        entry.label === 'live.v1' &&
        entry.frame?.type === 'message.updated' &&
        entry.frame.properties?.info?.id === completedReply.id &&
        entry.frame.properties.info.time.completed !== undefined,
    )
    expect(completedMessage).toBeDefined()
    expect(timeline.indexOf(completed)).toBeGreaterThan(timeline.indexOf(completedMessage!))
    expect(completed.at).toBeGreaterThanOrEqual(completedReply.data.time.completed!)
  })

  it('cannot recover completed command markers from native persistence or reconnect', () => {
    expect(final.tables.event.length).toBeGreaterThan(0)
    expect(final.tables.event.some((event) => event.type === 'message.part.updated.1')).toBe(true)
    expect(final.tables.event.filter((event) => event.type.startsWith('command.executed'))).toEqual(
      [],
    )
    expect(
      hooks.filter(
        (entry) =>
          entry.hook === 'event' &&
          entry.input.type === 'command.executed' &&
          entry.input.properties?.arguments === 'missed',
      ),
    ).toHaveLength(1)
    for (const label of ['reconnect.v1', 'missed-reconnect.v1']) {
      expect(
        timeline.find((entry) => entry.kind === 'sse.open' && entry.label === label)?.status,
      ).toBe(200)
      expect(
        timeline.some((entry) => entry.label === label && entry.frame?.type === 'server.connected'),
      ).toBe(true)
      expect(
        timeline.filter(
          (entry) => entry.label === label && entry.frame?.type === 'command.executed',
        ),
      ).toEqual([])
    }
    // Positive control: restart reconnects and carries one NEW command, not
    // either completed command from before the crash.
    const resumed = timeline.filter(
      (entry) => entry.label === 'restart.v1' && entry.frame?.type === 'command.executed',
    )
    expect(resumed).toHaveLength(1)
    expect(resumed[0]?.frame?.properties?.arguments).toBe('after-restart')
    expect(resumed[0]?.frame?.properties?.messageID).not.toBe(completedReply.id)
  })

  it('retains an expansion through a crash that never emits its command marker', () => {
    const kill = timeline.find((entry) => entry.kind === 'mark' && entry.name === 'crash.kill')
    expect(kill).toBeDefined()
    const native = message(beforeKill, kill?.expansionId)
    const reply = message(beforeKill, kill?.assistantId)
    expect(reply.data).toMatchObject({ role: 'assistant', parentID: native.id })
    expect(reply.data.time.completed).toBeUndefined()
    expect(
      timeline.filter(
        (entry) => entry.label === 'crash-live.v1' && entry.frame?.type === 'command.executed',
      ),
    ).toEqual([])
    expect(
      timeline.some(
        (entry) =>
          entry.label === 'crash-live.v1' &&
          entry.frame?.type === 'message.updated' &&
          entry.frame.properties?.info?.id === reply.id,
      ),
    ).toBe(true)
    expect(
      hooks.filter(
        (entry) =>
          entry.hook === 'event' &&
          entry.input.type === 'command.executed' &&
          entry.input.properties?.messageID === reply.id,
      ),
    ).toEqual([])
    expect(message(restart, native.id)).toEqual(native)
    expect(rows(restart, native)).toEqual(rows(beforeKill, native))
    const [item] = opencodeRowsToItems(rows(restart, native))
    expect(item).toMatchObject({
      role: 'user',
      promptEntry: true,
      text: 'S9 CMD TEMPLATE expanded with: SLOWTEXT crash-before-event',
    })
    expect(opencodePromptTextMatches('/probe SLOWTEXT crash-before-event', item?.text ?? '')).toBe(
      false,
    )
  })

  it('does not infer command origin from identical ordinary prompt text and metadata', () => {
    const summary = JSON.parse(read('summary.json')) as { ordinarySameText: MessageRow }
    const ordinary = message(final, summary.ordinarySameText.id)
    const { time: _expansionTime, ...expansionMetadata } = expansion.data
    const { time: _ordinaryTime, ...ordinaryMetadata } = ordinary.data
    expect(ordinaryMetadata).toEqual(expansionMetadata)
    const commandRows = rows(final, expansion)
    const ordinaryRows = rows(final, ordinary)
    expect(ordinaryRows).toHaveLength(1)
    expect(ordinaryRows[0]!.partData).toBe(commandRows[0]!.partData)
    const [item] = opencodeRowsToItems(ordinaryRows)
    expect(item).toMatchObject({
      role: 'user',
      promptEntry: true,
      text: 'S9 CMD TEMPLATE expanded with: completed',
    })
    expect(item).not.toHaveProperty('promptOrigin')
  })
})
