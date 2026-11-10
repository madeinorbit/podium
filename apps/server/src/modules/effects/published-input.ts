/**
 * WHAT THE FEED CARRIES OF AN EFFECT'S INPUT (ADR 12 D5, POD-6770).
 *
 * Five kinds publish less than they store: an answer shows how it was given
 * and never the answer, a file save its size and never its bytes. Each rule is
 * a plain function of the STORED input (the create parses the input before it
 * stores it), kept here with no imports from the kinds' own modules, so every
 * process that builds an effect record from the database applies the same
 * rule: the server, and the sync worker, which holds no executor.
 *
 * A kind with no rule publishes its stored input whole. A kind the server does
 * not serve publishes none (`effectPublication`).
 */

import type { EffectExecutorRegistry } from './registry'

type Stored = Record<string, unknown>

const pick = (input: Stored, keys: readonly string[]): Stored => {
  const out: Stored = {}
  for (const key of keys) if (input[key] !== undefined) out[key] = input[key]
  return out
}

/** The rules, by effect kind. Each takes the stored input as an object. */
export const EFFECT_PUBLISHED_INPUT = {
  // The feed shows how it was answered, never the answer.
  'session.answer': (input: Stored) => ({
    via: input.via,
    ...('interactionId' in input && input.interactionId !== undefined
      ? { interactionId: input.interactionId }
      : {}),
  }),
  // The task's long texts are on the task, not on its start.
  'issue.start': (input: Stored) => {
    const { description: _description, brief: _brief, ...rest } = input
    return rest
  },
  // A save shows where and how much, never the bytes.
  'file.write': (input: Stored) => ({
    path: input.path,
    size: (input.content as { length: number }).length,
    ...('root' in input ? { root: input.root } : {}),
    ...(input.baseHash ? { baseHash: input.baseHash } : {}),
  }),
  'session.handoff': (input: Stored) => ({ machineId: input.machineId }),
  'session.launch': (input: Stored) => ({
    ...pick(input, ['agentKind']),
    cwd: input.cwd,
    // Where its draft task goes (POD-6408): a device that reloads while the
    // launch waits paints the task's placeholder from this. Not a secret.
    ...pick(input, ['machineId', 'issueId', 'title', 'model', 'effort', 'wake', 'draftIssue']),
  }),
} as const satisfies Record<string, (input: Stored) => unknown>

export type PublishingEffectKind = keyof typeof EFFECT_PUBLISHED_INPUT

/** A kind's rule as its executor declares it (`EffectExecutor.publish`). */
export function publishedInputOf<In>(kind: PublishingEffectKind): (input: In) => unknown {
  return EFFECT_PUBLISHED_INPUT[kind] as unknown as (input: In) => unknown
}

/**
 * The publication of a process that holds no executors (the sync worker):
 * `served` are the kinds the server registered, and each publishes by its
 * rule above or whole.
 */
export function effectPublication(served: Iterable<string>): Pick<EffectExecutorRegistry, 'get'> {
  const kinds = new Set(served)
  const rules: Record<string, ((input: Stored) => unknown) | undefined> = EFFECT_PUBLISHED_INPUT
  return {
    get: (kind) => {
      if (!kinds.has(kind)) return undefined
      const publish = rules[kind]
      return (publish === undefined ? { kind } : { kind, publish }) as ReturnType<
        EffectExecutorRegistry['get']
      >
    },
  }
}
