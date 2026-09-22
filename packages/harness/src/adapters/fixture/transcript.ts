import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptItem } from '@podium/model'
import {
  fileTranscript,
  supported,
  transcriptFileExists,
  type Declared,
  type HarnessHandoffTranscript,
  type HarnessTranscript,
  type TranscriptSourceInput,
} from '../../manifest.js'
import { isRecord, stringField } from '../shared/json-util.js'

/**
 * Fixture transcript grammar (POD-4474) — the file grammar the Store, the lake
 * and the daemon transcript route read for the `fixture` test harness.
 *
 * One JSONL file per session at `<home>/.fixture/sessions/<resume>.jsonl`,
 * one record per line:
 *
 *   {v:1, id, ts, role:'user'|'agent', text, model?}
 *
 * Deliberately BORING on purpose: the point of the fixture is to prove the
 * mechanisms serve a third-party manifest through the real route, not to prove
 * a clever grammar. `model` rides the agent record so the runtime-facts reader
 * has something true to report; anything else is `[]`, the same way every
 * file harness ignores records it does not own.
 */

export function fixtureSessionPath(homeDir: string, resumeValue: string): string {
  return join(homeDir, '.fixture', 'sessions', `${resumeValue}.jsonl`)
}

export function fixtureRecordToItems(record: unknown): TranscriptItem[] {
  if (!isRecord(record)) return []
  const role = stringField(record, 'role')
  if (role !== 'user' && role !== 'agent') return []
  const text = stringField(record, 'text')?.trim()
  if (!text) return []
  const id = stringField(record, 'id') ?? `${role}-unkeyed`
  const ts = stringField(record, 'ts')
  return [{ id, role: role === 'agent' ? 'assistant' : 'user', text, ...(ts ? { ts } : {}) }]
}

export function fixtureRecordRuntime(record: unknown): { model?: string } {
  if (!isRecord(record)) return {}
  const model = stringField(record, 'model')?.trim()
  return model ? { model } : {}
}

/** The fixture reports one stable identity colour for its agent records. */
export function fixtureRecordColor(record: unknown): string | undefined {
  if (!isRecord(record) || stringField(record, 'role') !== 'agent') return undefined
  return '#7c6cf0'
}

export async function fixtureChainPaths(input: TranscriptSourceInput): Promise<string[]> {
  // Same contract as every file harness: no resume value names no
  // conversation (a cwd bucket holds many), so there is nothing to chain.
  if (!input.resumeValue) return []
  const home = input.homeDir ?? homedir()
  const path = fixtureSessionPath(home, input.resumeValue)
  return (await transcriptFileExists(path)) ? [path] : []
}

export const fixtureTranscript: Declared<HarnessTranscript> = supported(
  fileTranscript(fixtureChainPaths, fixtureRecordToItems, fixtureRecordRuntime, fixtureRecordColor),
)

export const fixtureHandoffTranscript: HarnessHandoffTranscript = {
  transcriptPlacement: ({ homeDir, resumeValue }) => fixtureSessionPath(homeDir, resumeValue),
  async transcriptForExport({ homeDir, resumeValue }) {
    const path = fixtureSessionPath(homeDir, resumeValue)
    if (!(await transcriptFileExists(path))) throw new Error('Fixture transcript not found')
    return { path }
  },
}
