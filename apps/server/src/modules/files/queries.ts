/**
 * THE TWO FILE QUERIES — `read` and `list`.
 *
 * A table rather than read contracts: a `visibility` class describes what a
 * command WRITES and a read writes nothing. Both run the SAME root allowlist the
 * write does (`assertAllowedRoot`), shared from `registry.ts` so the three
 * procedures cannot drift into three notions of "an allowed root".
 */

import type { TransportTag } from '@podium/commands'
import { ArtifactIdField, IssueIdField, SessionIdField } from '@podium/model'
import type { FileReadResultMessage } from '@podium/protocol'
import { z } from 'zod'
import { assertAllowedRoot, type FileState } from './registry'

const SERVED_ON: readonly TransportTag[] = ['trpc']

export interface FileQuery<In extends z.ZodTypeAny, Out> {
  readonly input: In
  readonly exposure: readonly TransportTag[]
  readonly run: (state: FileState, input: z.infer<In>) => Out
}

const query = <In extends z.ZodTypeAny, Out>(
  input: In,
  run: (state: FileState, input: z.infer<In>) => Out,
): FileQuery<In, Out> => ({ input, exposure: SERVED_ON, run })

export const FILE_QUERIES = {
  read: query(
    z.union([
      z.object({ sessionId: SessionIdField, path: z.string() }),
      z.object({ issueId: IssueIdField, artifactId: ArtifactIdField, path: z.string() }),
      z.object({ machineId: z.string().optional(), root: z.string(), path: z.string() }),
    ]),
    async (state, input): Promise<Omit<FileReadResultMessage, 'type' | 'requestId'>> => {
      // Artifact snapshots ([spec:SP-0fc9] #441) serve from the server-local
      // store — no daemon round-trip, no root allowlist (there is no root), and
      // no baseHash: snapshots are immutable and writes against them are
      // rejected. Moved verbatim from the router procedure.
      if ('artifactId' in input) {
        const r = await state.artifacts.read(input.issueId, input.artifactId, input.path)
        return r
          ? { ok: true, path: input.path, content: r.bytes.toString('utf8') }
          : { ok: false, path: input.path, error: 'artifact file not found' }
      }
      if ('root' in input) assertAllowedRoot(state, input.root)
      return state.rpc.readFile(input)
    },
  ),
  list: query(
    z.object({
      machineId: z.string().optional(),
      root: z.string(),
      path: z.string().optional(),
    }),
    (state, input) => {
      assertAllowedRoot(state, input.root)
      return state.rpc.listDir(input)
    },
  ),
} as const

export type FileQueryName = keyof typeof FILE_QUERIES

export const isFileQuery = (proc: string): proc is FileQueryName =>
  Object.hasOwn(FILE_QUERIES, proc)

export function isFileQueryExposedOn(proc: string, transport: TransportTag): boolean {
  if (!isFileQuery(proc)) return false
  return FILE_QUERIES[proc].exposure.includes(transport)
}
