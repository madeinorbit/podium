/**
 * THE FILE QUERIES — `read`, `list` and `search`.
 *
 * A table rather than read contracts: a `visibility` class describes what a
 * command WRITES and a read writes nothing. All three run the SAME root
 * allowlist the write does (`assertAllowedRoot`), shared from `registry.ts` so
 * the four procedures cannot drift into four notions of "an allowed root".
 */

import type { TransportTag } from '@podium/commands'
import { ArtifactIdField, IssueIdField, MachineIdField, SessionIdField } from '@podium/model'
import type { FileReadResultMessage } from '@podium/protocol'
import { z } from 'zod'
import { PathIndex, rankPaths } from './path-search'
import { assertAllowedRoot, type FileState } from './registry'

const SERVED_ON: readonly TransportTag[] = ['trpc']

/** One index per server process, shared by every caller of `search`: a burst of
 *  typing against one checkout is one `git ls-files`, not one per keystroke. */
const PATH_INDEX = new PathIndex()

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
      z.object({ machineId: MachineIdField.optional(), root: z.string(), path: z.string() }),
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
      machineId: MachineIdField.optional(),
      root: z.string(),
      path: z.string().optional(),
    }),
    (state, input) => {
      assertAllowedRoot(state, input.root)
      return state.rpc.listDir(input)
    },
  ),
  /**
   * TRACKED PATHS UNDER `root`, RANKED FOR `query` (POD-412) — what the chat
   * composer's `@` menu completes files against.
   *
   * Same root allowlist as `read` and `list`, and the same daemon seam: the
   * checkout may be on another machine, so the index is read by a fixed repo op
   * (`lsFiles`) rather than by touching a filesystem this process may not have.
   * The ranking runs HERE, and only `limit` rows go on the wire — see
   * `path-search.ts` for why the list must not reach the browser.
   *
   * An unreadable checkout answers with NO hits rather than an error: this
   * serves a keystroke, and a picker that throws a red banner at someone typing
   * a message is worse than one that quietly offers nothing.
   */
  search: query(
    z.object({
      machineId: MachineIdField.optional(),
      root: z.string(),
      query: z.string().max(256).default(''),
      limit: z.number().int().positive().max(50).default(10),
    }),
    async (state, input): Promise<{ paths: string[] }> => {
      assertAllowedRoot(state, input.root)
      const key = { ...(input.machineId ? { machineId: input.machineId } : {}), root: input.root }
      const paths = await PATH_INDEX.paths(key, () =>
        state.rpc.repoOp('lsFiles', input.root, undefined, input.machineId),
      )
      return { paths: rankPaths(paths, input.query.trim(), input.limit).map((hit) => hit.path) }
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
