/**
 * THE EFFECT EXECUTOR REGISTRY (ADR 12 D5 E2, POD-6357).
 *
 * One registration per effect kind (`issue.merge`, `file.write`, …). A kind
 * supplies everything that differs between effects, and nothing else:
 *
 *  - `input`: the schema of its input, applied when the record is created;
 *  - `target`: the live permission check on what it acts on (ADR 12 D2 step 4),
 *    the same for create, cancel and dismiss;
 *  - `deadlineMs`: how long a record may wait to start before it expires unrun;
 *  - `publish`: what of the input the feed carries (default: all of it);
 *  - `run`: the work, once the record is claimed (`running`);
 *  - `recover`: after a crash mid-run, check the world and say what happened.
 *
 * EXECUTOR RULES (ADR 12 D5). A run is keyed by the record's id: an executor
 * that finds its work already done for this id answers `succeeded`. It never
 * writes status itself; it returns an {@link EffectOutcome} and reports progress
 * through `ctx.stage`, and the runner writes both through the Authority with
 * the record id as the causation. A throw means the executor lost track after
 * the effect may have happened, so it reads as `unknown`, never as a retry.
 */

import type { EffectTarget } from '@podium/model'
import type { z } from 'zod'
import type { CommandPrincipal } from '../../command-principal'
import type { EffectRow } from '../../store/effects'
import type { SyncWriteTarget } from '../sync-write/registry'

/** How a run ended, as the executor says it. */
export type EffectOutcome =
  | { readonly status: 'succeeded'; readonly result?: unknown }
  | {
      readonly status: 'failed'
      readonly error: { readonly code: string; readonly message: string }
      readonly result?: unknown
    }
  | { readonly status: 'cancelled' }
  | {
      readonly status: 'unknown'
      readonly error?: { readonly code: string; readonly message: string }
    }

export interface EffectRunContext<In> {
  readonly record: EffectRow
  /** The input, parsed with the kind's schema. */
  readonly input: In
  /** Report progress (`rebasing`, `cloning`); it shows on every device. */
  stage(stage: string): Promise<void>
  /** Whether someone has asked to cancel, read now. Check at safe points. */
  cancelRequested(): Promise<boolean>
  /** Aborted when a cancel request commits while this run is live. */
  readonly signal: AbortSignal
}

export interface EffectExecutor<In = unknown> {
  readonly kind: string
  readonly input: z.ZodType<In>
  /** What the kind acts on, checked live; `undefined` refuses. */
  target(target: EffectTarget, principal: CommandPrincipal): Promise<SyncWriteTarget>
  /** How long a record may wait to start. */
  readonly deadlineMs: number
  /** What the feed carries of the input. Default: the input as given. */
  publish?(input: In): unknown
  run(ctx: EffectRunContext<In>): Promise<EffectOutcome>
  /**
   * A record found `running` with no live run (the server stopped mid-run).
   * Check the world: done → `succeeded`, not done and safe to say so → `failed`,
   * cannot tell → `unknown`. Absent: `unknown`.
   */
  recover?(ctx: EffectRunContext<In>): Promise<EffectOutcome>
}

export class EffectExecutorRegistry {
  private readonly executors = new Map<string, EffectExecutor>()

  register<In>(executor: EffectExecutor<In>): void {
    if (this.executors.has(executor.kind)) {
      throw new Error(`effects: ${executor.kind} is registered twice`)
    }
    if (!(executor.deadlineMs > 0)) {
      throw new Error(`effects: ${executor.kind} needs a positive deadline`)
    }
    this.executors.set(executor.kind, executor as unknown as EffectExecutor)
  }

  get(kind: string): EffectExecutor | undefined {
    return this.executors.get(kind)
  }

  kinds(): string[] {
    return [...this.executors.keys()]
  }
}
