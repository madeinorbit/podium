/**
 * THE FLEET-FAMILY READS (POD-314) — the queries that sat beside POD-384's
 * derived writes in `router.ts`: `repos`, `machines` and `discovery`.
 *
 * NOT CONTRACTS, for the reason POD-384 gave when it left them hand-written: a
 * `visibility` class describes what a command WRITES. The hub-role gate that
 * POD-384 derived from `serverRole` applies to the WRITES and is untouched here —
 * these reads were never hub-gated, and adding a gate under cover of a move would
 * be a behaviour change wearing a refactor's clothes.
 */

import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { FamilyState } from '../derived-family'
import { defineQuery } from '../query-table'
import { browseDirectories } from '../../repo-registry'

const q = defineQuery<FamilyState>()
const noInput = z.object({}).passthrough().optional()

export const REPO_QUERIES = {
  list: q(noInput, (s) => s.repos.list()),
  /** Full registered-repo rows incl. the human-facing prefix (#474) — the web's
   *  source for the linkify prefix set and the prefix editor. */
  listDetailed: q(noInput, (s) => s.store.repos.listRepos()),
  /** cwd → repo inference for the CLI: longest registered root containing `path`. */
  inferFromPath: q(z.object({ path: z.string() }), (s, input) => ({
    repoPath: s.repos.inferFromPath(input.path) ?? null,
  })),
  /**
   * Browse a machine's directories for the repo picker (POD-814) [spec:SP-3701].
   * With `machineId` the listing comes from THAT machine's daemon — the only
   * filesystem the user means. Without it, the legacy server-local browse: kept
   * strictly for old clients that predate the machine-aware picker, which reads
   * the hub host's own disk (wrong tree, and empty-to-absent in mode=server).
   */
  browse: q(
    z
      .object({
        path: z.string().optional(),
        includeHidden: z.boolean().optional(),
        machineId: z.string().optional(),
      })
      .optional(),
    async (s, input) => {
      if (input?.machineId) {
        const res = await s.modules.rpc.browseDirs(
          input.path,
          { ...(input.includeHidden === undefined ? {} : { includeHidden: input.includeHidden }) },
          input.machineId,
        )
        if (!res.listing)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: res.error ?? 'directory browse failed',
          })
        return res.listing
      }
      try {
        return await browseDirectories(input?.path, { includeHidden: input?.includeHidden })
      } catch (e) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: e instanceof Error ? e.message : String(e),
        })
      }
    },
  ),
} as const

export const DISCOVERY_QUERIES = {
  /** Most recent finished discovery for a machine (e.g. the automatic connect
   *  scan), so the picker can show results without re-scanning. */
  lastMachineScan: q(z.object({ machineId: z.string() }), (s, input) =>
    s.discovery?.lastResult(input.machineId) ?? null,
  ),
} as const
