/**
 * WHAT THE FEED CARRIES OF AN EFFECT'S INPUT (ADR 12 D5, POD-6770).
 *
 * Five kinds publish less than they store: an answer shows how it was given
 * and never the answer, a file save its size and never its bytes. Each rule is
 * serializable data applied to the STORED input (the create parses the input
 * before it stores it), kept here with no imports from the kinds' own modules, so every
 * process that builds an effect record from the database applies the same
 * rule: the server, and the sync worker, which holds no executor.
 *
 * A kind with no rule publishes its stored input whole. A kind the server does
 * not serve publishes none (`effectPublication`).
 */

import type { EffectExecutorRegistry } from './registry'

type Stored = Record<string, unknown>

type Field =
  | string
  | { readonly lengthOf: string }
  | { readonly from: string; readonly when: 'defined' | 'present' | 'truthy' }
type PublicationRule =
  | { readonly omit: readonly string[] }
  | { readonly fields: Readonly<Record<string, Field>> }

const defined = (key: string): Field => ({ from: key, when: 'defined' })

/** The rules, by effect kind. The kind token fingerprints these data, rather
 * than function source, so bundled server and worker builds get the same token. */
export const EFFECT_PUBLISHED_INPUT = {
  // The feed shows how it was answered, never the answer.
  'session.answer': { fields: { via: 'via', interactionId: defined('interactionId') } },
  // The task's long texts are on the task, not on its start.
  'issue.start': { omit: ['description', 'brief'] },
  // A save shows where and how much, never the bytes.
  'file.write': {
    fields: {
      path: 'path',
      size: { lengthOf: 'content' },
      root: { from: 'root', when: 'present' },
      baseHash: { from: 'baseHash', when: 'truthy' },
    },
  },
  'session.handoff': { fields: { machineId: 'machineId' } },
  'session.launch': {
    fields: {
      agentKind: defined('agentKind'),
      cwd: 'cwd',
      // Where its draft task goes (POD-6408): a device that reloads while the
      // launch waits paints the task's placeholder from this. Not a secret.
      machineId: defined('machineId'),
      issueId: defined('issueId'),
      title: defined('title'),
      model: defined('model'),
      effort: defined('effort'),
      wake: defined('wake'),
      draftIssue: defined('draftIssue'),
    },
  },
} as const satisfies Record<string, PublicationRule>

function publish(rule: PublicationRule, input: Stored): Stored {
  if ('omit' in rule) {
    const out = { ...input }
    for (const key of rule.omit) delete out[key]
    return out
  }
  const out: Stored = {}
  for (const [key, field] of Object.entries(rule.fields)) {
    if (typeof field === 'string') out[key] = input[field]
    else if ('lengthOf' in field) out[key] = (input[field.lengthOf] as { length: number }).length
    else {
      const value = input[field.from]
      const include =
        field.when === 'present'
          ? field.from in input
          : field.when === 'defined'
            ? value !== undefined
            : !!value
      if (include) out[key] = value
    }
  }
  return out
}

export type PublishingEffectKind = keyof typeof EFFECT_PUBLISHED_INPUT

/** A kind's rule as its executor declares it (`EffectExecutor.publish`). */
export function publishedInputOf<In>(kind: PublishingEffectKind): (input: In) => unknown {
  return (input) => publish(EFFECT_PUBLISHED_INPUT[kind], input as Stored)
}

/**
 * The publication of a process that holds no executors (the sync worker):
 * `served` are the kinds the server registered, and each publishes by its
 * rule above or whole.
 */
export function effectPublication(served: Iterable<string>): Pick<EffectExecutorRegistry, 'get'> {
  const kinds = new Set(served)
  const rules: Readonly<Record<string, PublicationRule | undefined>> = EFFECT_PUBLISHED_INPUT
  return {
    get: (kind) => {
      if (!kinds.has(kind)) return undefined
      const rule = rules[kind]
      return (
        rule === undefined ? { kind } : { kind, publish: (input: Stored) => publish(rule, input) }
      ) as ReturnType<EffectExecutorRegistry['get']>
    },
  }
}
