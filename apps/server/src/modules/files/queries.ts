/**
 * THE FILE QUERIES — `read`, `list` and `search`.
 *
 * A table rather than read contracts: a `visibility` class describes what a
 * command WRITES and a read writes nothing.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE THREE USED TO ASK, AND WHY IT WAS THE WRONG QUESTION (PDM-272)
 * ---------------------------------------------------------------------------
 *
 * All three used to run the SAME root allowlist the write does, and the sentence
 * that stood here said so approvingly: four procedures, one notion of "an allowed
 * root". That was true. It was also the entire authorization these reads had.
 *
 * `assertAllowedRoot` asks whether a path is a known REPOSITORY. It stops a
 * caller leaving a directory; it cannot decide whether this caller may read what
 * is inside it. A rule about paths is not a rule about people — and two of the
 * three arms of `read` did not even reach it. The `sessionId` arm matched neither
 * branch and fell through to the daemon with no check of ANY kind, while
 * `sessions.transcriptRead` asserted ownership for the same session's bytes one
 * module away. The `artifactId` arm served any issue id the caller named.
 *
 * So the three now address `state.files`, a `FileAccessGate` pre-bound to this
 * request's caller, and the allowlist is one of the things it runs rather than
 * all of what they do. The daemon RPC and the artifact store are no longer in
 * this family's seam at all: there is no longer an unauthorized way to spell
 * these reads. See `file-access-gate.ts` for which rule each door asks and
 * whose rule it is.
 */

import type { TransportTag } from '@podium/commands'
import { ArtifactIdField, IssueIdField, MachineIdField, SessionIdField } from '@podium/model'
import type { FileReadResultMessage } from '@podium/protocol'
import { z } from 'zod'
import { PathIndex, rankPaths } from './path-search'
import type { FileState } from './registry'

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
      // rejected. THE ISSUE IS NOW AUTHORIZED FIRST (PDM-272): this arm served
      // `artifacts.read(issueId, …)` for any issue id the caller could name.
      if ('artifactId' in input) {
        const r = await state.files.readArtifact(input.issueId, input.artifactId, input.path)
        return r
          ? { ok: true, path: input.path, content: r.bytes.toString('utf8') }
          : { ok: false, path: input.path, error: 'artifact file not found' }
      }
      // THE THIRD ARM IS NOW A DOOR RATHER THAN A FALLTHROUGH. It used to be
      // neither of the two branches above and so reached the daemon unchecked;
      // it is spelled out here because an `else` is how it went unnoticed.
      if ('root' in input) {
        return await state.files.readRoot(input.root, input.path, input.machineId)
      }
      return await state.files.readSession(input.sessionId, input.path)
    },
  ),
  list: query(
    z.object({
      machineId: MachineIdField.optional(),
      root: z.string(),
      path: z.string().optional(),
    }),
    async (state, input) =>
      await state.files.listRoot(input.root, input.path, input.machineId),
  ),
  /**
   * VISIBLE PATHS UNDER `root`, RANKED FOR `query` (POD-412) — what file
   * quick-open and the chat composer's `@` menu complete against.
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
      // AUTHORIZATION RUNS ON EVERY CALL; THE INDEX LOADS ONLY ON A MISS
      // (PDM-272). These are two different frequencies and conflating them is a
      // live hole: the loader below is not reached on a cache hit, so a gate
      // called only from inside it would serve a warm index to a caller who may
      // not read the root at all. `requireSearchableRoot` is therefore
      // unconditional, and it hands back the RESOLVED machine.
      //
      // THE CACHE IS KEYED ON THAT RESOLVED MACHINE, not on the requested one.
      // Keying on `input.machineId` files the default machine's index under
      // `undefined` and then serves it to a caller who named a different machine
      // explicitly.
      const machineId = await state.files.requireSearchableRoot(input.root, input.machineId)
      const paths = await PATH_INDEX.paths({ machineId, root: input.root }, async () =>
        await state.files.lsFiles(input.root, machineId),
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
