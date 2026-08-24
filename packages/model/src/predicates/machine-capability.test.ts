/**
 * THE THREE AXES, AND THE RULE THAT THEY STAY APART (POD-2700).
 *
 * `machine-selection.test.ts` next door covers affinity and handoff. This file
 * covers only the structural axis added by POD-2700 and the words that come out
 * of it, because that is where the reported failure lived: a server-only
 * coordinator that every surface described as "offline", so every remedy offered
 * to the operator was one they could not take.
 */
import { describe, expect, it } from 'vitest'
import type { MachineComponent } from '../entities/machine'
import {
  HOST_REPOS,
  machineChoices,
  machineChoiceSummary,
  machineEmptyState,
  machineExclusionNote,
  machineRejection,
  machineRejectionMessage,
  machinesFor,
  runAgent,
  structuralEligibility,
  structuralRejection,
} from './machine-selection'

const machine = (
  id: string,
  opts: {
    online?: boolean
    components?: MachineComponent[]
    use?: 'granted' | 'denied'
    harness?: boolean
  } = {},
) => ({
  id,
  name: id,
  online: opts.online ?? true,
  ...(opts.components !== undefined ? { components: opts.components } : {}),
  ...(opts.use ? { use: opts.use } : {}),
  ...(opts.harness === undefined
    ? {}
    : {
        inventory: {
          agents: [
            { kind: 'claude-code', installed: opts.harness, login: { state: 'in' as const } },
          ],
        },
      }),
})

/** The sandbox that broke: a coordinator with `server` and no daemon. */
const COORDINATOR = machine('source', { online: true, components: ['server'] })
const LAPTOP = machine('mango', { online: true, components: ['daemon'], harness: true })
const SLEEPING = machine('kiwi', { online: false, components: ['daemon'], harness: true })

describe('structuralRejection', () => {
  it('refuses a machine that runs no daemon, however online it is', () => {
    expect(structuralRejection(COORDINATOR)).toBe('no-daemon')
    expect(structuralRejection(LAPTOP)).toBeUndefined()
  })

  it('does NOT refuse when components were never recorded', () => {
    // The concession documented on the function: absent means an old producer
    // has not answered, and reading silence as "incapable" would blank every
    // picker in the fleet at once — the defect this work removes, restated.
    expect(structuralRejection(machine('legacy'))).toBeUndefined()
  })

  it('DOES refuse on an empty array — that is an answer, not a silence', () => {
    expect(structuralRejection(machine('pairing', { components: [] }))).toBe('no-daemon')
  })

  it('survives the socket dropping: the fact is durable, not live', () => {
    expect(structuralRejection(SLEEPING)).toBeUndefined()
  })
})

describe('the canonical rejection order', () => {
  it('answers unauthorized first, even for a machine with no daemon', () => {
    // §3.2's oracle rule: a denied machine's hidden state must not be readable
    // off its refusal reason. If this ever answered 'no-daemon', a principal
    // without access could enumerate which machines run daemons.
    const denied = machine('theirs', { components: ['server'], use: 'denied' })
    expect(structuralEligibility(denied, HOST_REPOS)).toBe('unauthorized')
    expect(machineRejection(denied, HOST_REPOS)).toBe('unauthorized')
  })

  it('answers no-daemon BEFORE offline', () => {
    const offlineCoordinator = machine('source', { online: false, components: ['server'] })
    expect(machineRejection(offlineCoordinator, HOST_REPOS)).toBe('no-daemon')
  })

  it('answers offline before the harness detail', () => {
    const asleep = machine('kiwi', { online: false, components: ['daemon'], harness: false })
    expect(machineRejection(asleep, runAgent('claude-code'))).toBe('offline')
  })

  it('reaches the harness detail once the first three axes pass', () => {
    const bare = machine('mango', { components: ['daemon'], harness: false })
    expect(machineRejection(bare, runAgent('claude-code'))).toBe('harness-missing')
  })
})

describe('the picker projection', () => {
  const fleet = [COORDINATOR, LAPTOP, SLEEPING]

  it('lists the offline repo host and excludes the coordinator', () => {
    const choices = machineChoices(fleet, HOST_REPOS)
    const listed = choices.filter((c) => c.listed).map((c) => c.machine.id)
    // THE WHOLE DISTINCTION IN ONE ASSERTION: kiwi is asleep and stays on the
    // list (disabled) because waking it is real advice; source can never do the
    // job and leaves the list to be counted instead.
    expect(listed).toEqual(['mango', 'kiwi'])
    expect(choices.find((c) => c.machine.id === 'kiwi')?.rejection).toBe('offline')
    expect(choices.find((c) => c.machine.id === 'source')?.rejection).toBe('no-daemon')
  })

  it('machinesFor keeps offline hosts — it is the structural filter, not the live one', () => {
    expect(machinesFor(fleet, HOST_REPOS).map((m) => m.id)).toEqual(['mango', 'kiwi'])
  })
})

const COPY = {
  action: 'host a repository',
  capability: 'host repositories',
  remedy: 'Pair a machine that runs the Podium daemon to add repos.',
}

describe('the empty state names the axis the user is actually on', () => {
  const stateFor = (fleet: ReturnType<typeof machine>[]) =>
    machineEmptyState(machineChoiceSummary(machineChoices(fleet, HOST_REPOS)), COPY)

  it('says nothing at all when something qualifies', () => {
    expect(stateFor([COORDINATOR, LAPTOP])).toBeNull()
  })

  it('the reported failure: only a coordinator, and it explains itself', () => {
    const state = stateFor([COORDINATOR])
    expect(state?.title).toBe('No machine can host a repository yet.')
    expect(state?.detail).toContain('runs only the Podium server')
    expect(state?.remedy).toContain('Pair a machine')
    // The word that must NOT appear: it would send the operator to wait for a
    // daemon that is never coming.
    expect(`${state?.title ?? ''} ${state?.detail ?? ''}`).not.toContain('offline')
  })

  it('all capable machines asleep: names them, and says to wake one', () => {
    const state = stateFor([SLEEPING, machine('plum', { online: false, components: ['daemon'] })])
    expect(state?.detail).toContain('kiwi, plum')
    expect(state?.detail).toContain('offline')
    // No "pair a machine" here — the machines already exist and can do the job.
    expect(state?.remedy).toBeUndefined()
  })

  it('all denied: the access wording, and NO further detail', () => {
    const state = stateFor([machine('theirs', { components: ['daemon'], use: 'denied' })])
    expect(state?.detail).toContain('Ask its owner')
    expect(state?.detail).not.toContain('theirs')
  })

  it('an empty fleet is its own answer, not "all incapable"', () => {
    expect(stateFor([])?.title).toBe('No machines are paired yet.')
  })
})

describe('the exclusion footnote', () => {
  it('counts what was left out, and names only what it may name', () => {
    const summary = machineChoiceSummary(
      machineChoices(
        [LAPTOP, COORDINATOR, machine('theirs', { components: ['daemon'], use: 'denied' })],
        HOST_REPOS,
      ),
    )
    const note = machineExclusionNote(summary, COPY)
    expect(note).toContain("1 machine can't host repositories (source")
    expect(note).toContain("1 machine you don't have access to")
    expect(note).not.toContain('theirs')
  })

  it('is absent when the picker has nothing to explain', () => {
    const summary = machineChoiceSummary(machineChoices([LAPTOP, SLEEPING], HOST_REPOS))
    expect(machineExclusionNote(summary, COPY)).toBeUndefined()
  })

  it('separates a machine mid-pairing from a server-only one', () => {
    const summary = machineChoiceSummary(
      machineChoices([LAPTOP, machine('fresh', { components: [] })], HOST_REPOS),
    )
    expect(summary.awaitingFirstConnection.map((m) => m.id)).toEqual(['fresh'])
    expect(summary.incapable).toEqual([])
    expect(machineExclusionNote(summary, COPY)).toContain('waiting for a first daemon connection')
  })
})

describe('the refusal sentence', () => {
  it('gives offline and no-daemon different advice', () => {
    expect(machineRejectionMessage('kiwi', 'offline', 'host repositories')).toContain(
      'bring its daemon online',
    )
    const incapable = machineRejectionMessage('source', 'no-daemon', 'host repositories')
    expect(incapable).toBe("machine 'source' runs no Podium daemon and cannot host repositories")
    expect(incapable).not.toContain('online')
  })

  it('says nothing beyond the denial for an unauthorized machine', () => {
    const denied = machineRejectionMessage('theirs', 'unauthorized', 'host repositories')
    expect(denied).toContain('do not have access')
    expect(denied).not.toContain('daemon')
  })
})
