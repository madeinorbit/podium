/**
 * `files.search` AGAINST A REAL CHECKOUT (POD-412).
 *
 * The unit tests next door prove the ranker; this one proves the SEAM — that the
 * `lsFiles` repo op the daemon runs produces output this query can parse, and
 * that a person typing a filename gets that file's real path back. It runs the
 * daemon's own `repoOpCommand('lsFiles')` argv through execFile against this
 * repository, so a change to either side that stops agreeing fails here rather
 * than in a browser.
 *
 * The socket is the only thing stubbed: `rpc.repoOp` runs the command locally
 * instead of asking a daemon to. Nothing about the command, the parsing or the
 * ranking is faked.
 *
 * THE GATE IS REAL TOO, SINCE PDM-272. `FileState` is now a single
 * `FileAccessGate` and this fixture builds the shipped one, so these cases pass
 * through the same authorization the product runs — the owner of the machine
 * asks for their own repository and gets it. The refusal case at the bottom is
 * still the ROOT ALLOWLIST's, unchanged; who may read a root is
 * `queries.authz.test.ts`'s subject and is not restated here.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { asMachineId, asUserId, type Capability } from '@podium/model'
import { TRPCError } from '@trpc/server'
import { describe, expect, it } from 'vitest'
import type { CommandPrincipal } from '../../command-principal'
import { fileAccessGate, type FileAccessModules } from './file-access-gate'
import { FILE_QUERIES } from './queries'
import type { FileState } from './registry'

const execFileAsync = promisify(execFile)
const ROOT = new URL('../../../../..', import.meta.url).pathname.replace(/\/$/, '')

/** The `lsFiles` argv, spelled exactly as `apps/daemon/src/repo-op.ts` builds it
 *  (and asserted there, in `repo-op.test.ts`). The daemon is not imported: it is
 *  a different app, and a server test reaching into it would be a layering the
 *  runtime does not have. */
const LS_FILES = [
  '--no-optional-locks',
  'ls-files',
  '--cached',
  '--others',
  '--exclude-standard',
  '-z',
]

const MACHINE = asMachineId('m_local')
const USER = asUserId('u_local')

/** A file state whose daemon is this process: same argv, real git, real repo —
 *  and, since PDM-272, the real gate in front of it, held by the machine's own
 *  owner so the authorization these cases pass is the shipped one. */
const stateFor = (allowedRoots: string[]): FileState => ({
  files: fileAccessGate(
    {
      rpc: {
        repoOp: async (op: string) => {
          if (op !== 'lsFiles') return { ok: false, output: `unexpected op ${op}` }
          const { stdout } = await execFileAsync('git', ['-C', ROOT, ...LS_FILES], {
            maxBuffer: 8 * 1024 * 1024,
          })
          return { ok: true, output: stdout }
        },
      },
      machines: {
        defaultMachine: async () => MACHINE,
        ownershipRows: async () => [{ id: MACHINE, ownerUserId: USER, name: 'local' }],
      },
    } as unknown as FileAccessModules,
    { list: async () => allowedRoots } as never,
    { userId: USER, capability: {} as Capability },
    { kind: 'user', user: USER, capability: {} as Capability } as unknown as CommandPrincipal,
  ),
})

const search = (state: FileState, query: string, limit = 8) =>
  FILE_QUERIES.search.run(state, { root: ROOT, query, limit })

describe('files.search', () => {
  it('finds a file in this repository by its name', async () => {
    const { paths } = await search(stateFor([ROOT]), 'ChatComposer')
    expect(paths[0]).toBe('apps/web/src/features/chat/ChatComposer.tsx')
  })

  it('narrows on a path fragment', async () => {
    const { paths } = await search(stateFor([ROOT]), 'modules/files/queries')
    expect(paths).toContain('apps/server/src/modules/files/queries.ts')
  })

  it('keeps ignored dependency paths out of the search index', async () => {
    const { paths } = await search(stateFor([ROOT]), 'node_modules/vitest')
    expect(paths).toEqual([])
  })

  it('returns repo-RELATIVE paths, which is what an agent in that cwd can open', async () => {
    const { paths } = await search(stateFor([ROOT]), 'package.json', 3)
    expect(paths.every((p) => !p.startsWith('/'))).toBe(true)
  })

  it('honours the cap on a query that matches thousands of files', async () => {
    const { paths } = await search(stateFor([ROOT]), 'e', 5)
    expect(paths).toHaveLength(5)
  })

  it('refuses a root outside the registered repositories', async () => {
    await expect(search(stateFor(['/somewhere/else']), 'x')).rejects.toBeInstanceOf(TRPCError)
  })
})
