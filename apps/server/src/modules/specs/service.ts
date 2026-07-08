/**
 * Specs module (pspec v1, #135) — the living nested spec in `<repo>/pspec/`.
 *
 * Thin service over the pure file store in ../../pspec.ts. Owns the router-equal
 * input schemas and the repo-root allowlist gate, so BOTH entries — the tRPC
 * `specs.*` slice (router.ts) and the daemon relay (`podium spec` via the relay
 * gate's caller) — run the identical validation + authorization. Specs read and
 * write real files inside a repo, so only registered repo roots are fair game.
 *
 * Prototype scope (unchanged from main): local-filesystem repos only — the
 * reads/writes happen on the server host.
 */

import { statSync } from 'node:fs'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import {
  createSpec,
  getSpec,
  listSpecs,
  removeSpec,
  saveSpec,
  searchSpecs,
  type SpecComponent,
  type SpecComponentMeta,
  type SpecSearchHit,
} from '../../pspec'
import { isAllowedRoot } from '../../root-allowlist'

const byRepo = { repoPath: z.string().min(1) }

/** Router-equal input schemas — the tRPC slice mounts these same objects. */
export const specsInputs = {
  list: z.object({ ...byRepo }),
  get: z.object({ ...byRepo, id: z.string().min(1) }),
  create: z.object({ ...byRepo, title: z.string().min(1), parent: z.string() }),
  save: z.object({
    ...byRepo,
    id: z.string().min(1),
    body: z.string().optional(),
    title: z.string().optional(),
    parent: z.string().optional(),
    order: z.number().optional(),
    status: z.enum(['active', 'superseded', 'draft']).optional(),
  }),
  remove: z.object({ ...byRepo, id: z.string().min(1) }),
  search: z.object({ ...byRepo, query: z.string() }),
} as const

type In<K extends keyof typeof specsInputs> = z.infer<(typeof specsInputs)[K]>

export interface SpecsServiceDeps {
  /** Registered repo roots — the allowlist gate (same source RepoRegistry lists). */
  repoRoots: () => string[]
}

export class SpecsService {
  constructor(private readonly deps: SpecsServiceDeps) {}

  /**
   * Specs read/write real files in a repo — only registered repo roots are fair
   * game, and the root must actually exist ON THIS HOST. A hub can know repos
   * that live on other (possibly offline) machines; without the existence check
   * a save against such a root used to fall through to mkdir/write, throw a raw
   * fs error, and surface as an unlogged 500.
   */
  private requireRepoRoot(repoPath: string): void {
    if (!isAllowedRoot(this.deps.repoRoots(), repoPath)) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'root is not a known repository path' })
    }
    let isDir = false
    try {
      isDir = statSync(repoPath).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `repository path does not exist on this machine: ${repoPath}`,
      })
    }
  }

  /** Map store-layer failures to typed tRPC errors instead of raw 500s:
   *  filesystem errors → PRECONDITION_FAILED (the repo dir is missing/unwritable
   *  here), pspec validation errors (unknown component, cycle, …) → BAD_REQUEST. */
  private run<T>(fn: () => T): T {
    try {
      return fn()
    } catch (err) {
      if (err instanceof TRPCError) throw err
      const errno = (err as NodeJS.ErrnoException | null)?.code
      if (typeof errno === 'string') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `spec storage unavailable (${errno}) — is the repository present and writable on this machine?`,
        })
      }
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  list(input: In<'list'>): SpecComponentMeta[] {
    this.requireRepoRoot(input.repoPath)
    return this.run(() => listSpecs(input.repoPath))
  }

  get(input: In<'get'>): SpecComponent | null {
    this.requireRepoRoot(input.repoPath)
    return this.run(() => getSpec(input.repoPath, input.id))
  }

  create(input: In<'create'>): SpecComponent {
    this.requireRepoRoot(input.repoPath)
    return this.run(() => createSpec(input.repoPath, input))
  }

  save(input: In<'save'>): SpecComponent {
    this.requireRepoRoot(input.repoPath)
    const { repoPath, ...rest } = input
    return this.run(() => saveSpec(repoPath, rest))
  }

  remove(input: In<'remove'>): { ok: boolean } {
    this.requireRepoRoot(input.repoPath)
    this.run(() => removeSpec(input.repoPath, input.id))
    return { ok: true }
  }

  search(input: In<'search'>): SpecSearchHit[] {
    this.requireRepoRoot(input.repoPath)
    return this.run(() => searchSpecs(input.repoPath, input.query))
  }

  /** Whether `proc` is a servable specs procedure (relay caller surface). */
  has(proc: string): boolean {
    return Object.hasOwn(specsInputs, proc)
  }

  /**
   * Relay entry (`podium spec` over the daemon): zod-parse with the SAME schema
   * the router mounts, then run the proc — the repo-root gate applies inside each
   * method, so the relay path cannot reach an unregistered root. Returns undefined
   * for an unknown proc so the gate shapes its own "no such procedure" reply.
   */
  invoke(proc: string, rawInput: unknown): Promise<unknown> | undefined {
    if (!this.has(proc)) return undefined
    return Promise.resolve().then(() => {
      const schema = (specsInputs as Record<string, z.ZodTypeAny>)[proc]!
      const input = schema.parse(rawInput)
      const method = (this as unknown as Record<string, (i: unknown) => unknown>)[proc]!
      return method.call(this, input)
    })
  }
}
