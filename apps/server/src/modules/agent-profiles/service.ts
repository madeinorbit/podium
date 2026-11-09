/**
 * AGENT PROFILES (POD-6107, flight deck D3/D4) — named agent setups.
 *
 * Two jobs:
 *
 *  1. The library: list/show/export, and the synced record's create/edit/
 *     remove (`records.agentProfile.*`, POD-6676). Profiles are edited by
 *     PEOPLE only; an agent session may pick a profile (`--profile` on an issue
 *     or a spawn) but every write here refuses it.
 *  2. The launch: {@link AgentProfileService.launch} turns a profile id plus an
 *     issue's or session's own fields into the concrete harness/model/effort/
 *     machine a session starts with. The rule (profile, fields on top) is the
 *     model's `resolveAgentSetup`; what is decided HERE is only which candidate
 *     is usable, because that is a machine fact.
 */

import {
  type AgentProfileWire,
  type AgentSetupFields,
  asMachineId,
  formatAgentProfileMarkdown,
  isAgentFieldSet,
  type MachineId,
  machineByRef,
  type NameableMachine,
  pickAgentCandidate,
  resolveAgentSetup,
  type SessionId,
  type UserId,
} from '@podium/model'
import type { EntityChangeSpec, LedgerCommitOp } from '@podium/sync'
import type { AgentProfilesRepository } from '../../store/agent-profiles'

/** A refusal the caller can act on; the entry point answers it with this text. */
export class AgentProfileRefusal extends Error {}

/** What a profile write commits through: the command's writer (POD-6676). */
export interface AgentProfileWriter {
  commit<T>(op: LedgerCommitOp<T>): Promise<{ result: T }>
}

/** A create's fields or an edit's patch, as the generic record declares them. */
export interface AgentProfileRecordFields {
  name?: string
  description?: string
  candidates?: AgentProfileWire['candidates']
  /** A machine id (a visible machine's name is resolved to its id), or null. */
  machineId?: string | null
  instructions?: string
}

/** One profile's change entry: the row as stored. */
export function agentProfileUpsert(row: AgentProfileWire): EntityChangeSpec {
  return { entity: 'agentProfile', id: row.id, op: 'upsert', value: row }
}

/** Who is asking: a person, or an agent session acting for one. */
export interface AgentProfileCaller {
  userId: UserId
  /** Set when an agent session is the caller. */
  actorSessionId: SessionId | null
}

export interface AgentProfileDeps {
  store: AgentProfilesRepository
  now(): string
  /** Machines the caller may see, for `machine: <name>` in a profile. */
  listMachines(): Promise<NameableMachine[]>
  /** Throws when `agentKind` cannot run on the machine the placement would pick. */
  requireRunnable(input: {
    machineId: MachineId | null
    cwd: string
    agentKind: string
  }): Promise<void>
  /** Instance role of a person; edits are admin-grade (matrix row `agent-profiles`). */
  roleOf(userId: UserId): Promise<string | undefined>
}

export interface AgentLaunch {
  profile: { id: string; name: string } | null
  /** Concrete harness, or `auto` for the Settings default. */
  agentKind: string
  model: string
  effort: string
  machineId: MachineId | null
  instructions: string
}

/** A profile as the CLI shows it: the stored row plus the machine's name. */
export type AgentProfileView = AgentProfileWire & { machineName: string | null }

export class AgentProfileService {
  constructor(private readonly deps: AgentProfileDeps) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async list(): Promise<AgentProfileView[]> {
    const [profiles, names] = await Promise.all([this.deps.store.list(), this.machineNames()])
    return profiles.map((p) => this.view(p, names))
  }

  /** By id or by name. */
  async find(ref: string): Promise<AgentProfileWire | null> {
    const trimmed = ref.trim()
    return (
      (await this.deps.store.get(trimmed)) ??
      (await this.deps.store.getByName(trimmed.toLowerCase()))
    )
  }

  async show(ref: string): Promise<AgentProfileView> {
    return this.view(await this.require(ref), await this.machineNames())
  }

  /** Every profile (or one) in the `.podium/agents/<name>.md` shape. */
  async export(ref?: string): Promise<Array<{ name: string; text: string }>> {
    const names = await this.machineNames()
    const profiles = ref ? [await this.require(ref)] : await this.deps.store.list()
    return profiles.map((p) => ({
      name: p.name,
      text: formatAgentProfileMarkdown({
        name: p.name,
        description: p.description,
        candidates: p.candidates,
        machine: p.machineId ? (names.get(p.machineId) ?? p.machineId) : null,
        instructions: p.instructions,
      }),
    }))
  }

  // -------------------------------------------------------------------------
  // The synced record's writes (POD-6676): `records.agentProfile.*`
  // -------------------------------------------------------------------------

  /**
   * May this caller write profiles at all: a person (never an agent session),
   * an instance admin now. Throws the refusal the caller reads.
   */
  async assertMayWrite(caller: AgentProfileCaller): Promise<void> {
    await this.requirePerson(caller)
  }

  /** The stored row by id, for the generic layer's collision check. */
  async record(id: string): Promise<AgentProfileWire | null> {
    return await this.deps.store.get(id)
  }

  /**
   * `records.agentProfile.create`: a new profile under the device's id. The
   * name must be free; a machine is stored by id (a visible machine's name is
   * resolved to it, as the CLI's `--machine` always was).
   */
  async createRecord(
    caller: AgentProfileCaller,
    writer: AgentProfileWriter,
    id: string,
    fields: AgentProfileRecordFields,
  ): Promise<AgentProfileWire> {
    await this.requirePerson(caller)
    const name = fields.name ?? ''
    if (await this.deps.store.getByName(name)) {
      throw new AgentProfileRefusal(
        `a profile named '${name}' already exists — use \`podium profile update ${name}\``,
      )
    }
    const machineId = await this.machineIdFor(fields.machineId ?? null)
    const { result } = await writer.commit({
      write: async () =>
        await this.deps.store.insert({
          id,
          name,
          description: fields.description ?? '',
          candidates: fields.candidates ?? [],
          machineId,
          instructions: (fields.instructions ?? '').trim(),
          actor: actorOf(caller),
          now: this.deps.now(),
        }),
      changes: (row) => [agentProfileUpsert(row)],
    })
    return result
  }

  /**
   * `records.agentProfile.edit`: the named fields only, over the stored row
   * (field-level last writer wins, design §1.9). A rename must stay unique.
   */
  async editRecord(
    caller: AgentProfileCaller,
    writer: AgentProfileWriter,
    id: string,
    patch: AgentProfileRecordFields,
  ): Promise<AgentProfileWire> {
    await this.requirePerson(caller)
    const current = await this.deps.store.get(id)
    if (!current) throw new AgentProfileRefusal(`no agent profile '${id}'`)
    if (patch.name !== undefined && patch.name !== current.name) {
      const clash = await this.deps.store.getByName(patch.name)
      if (clash && clash.id !== current.id) {
        throw new AgentProfileRefusal(`a profile named '${patch.name}' already exists`)
      }
    }
    const machineId =
      patch.machineId === undefined
        ? (current.machineId as MachineId | null)
        : await this.machineIdFor(patch.machineId)
    const { result } = await writer.commit({
      write: async () => {
        await this.deps.store.update({
          id,
          name: patch.name ?? current.name,
          description: patch.description ?? current.description,
          candidates: patch.candidates ?? current.candidates,
          machineId,
          instructions:
            patch.instructions === undefined ? current.instructions : patch.instructions.trim(),
          actor: actorOf(caller),
          now: this.deps.now(),
        })
        return (await this.deps.store.get(id)) as AgentProfileWire
      },
      changes: (row) => [agentProfileUpsert(row)],
    })
    return result
  }

  /** `records.agentProfile.remove`: refused while an open issue uses it. */
  async removeRecord(
    caller: AgentProfileCaller,
    writer: AgentProfileWriter,
    id: string,
  ): Promise<void> {
    await this.requirePerson(caller)
    const current = await this.deps.store.get(id)
    if (!current) throw new AgentProfileRefusal(`no agent profile '${id}'`)
    await this.refuseWhileUsed(current)
    await writer.commit({
      write: async () => await this.deps.store.delete(id),
      changes: (removed) => (removed ? [{ entity: 'agentProfile', id, op: 'remove' }] : []),
    })
  }

  // -------------------------------------------------------------------------
  // The launch
  // -------------------------------------------------------------------------

  /**
   * The concrete setup a session starts with: the profile (when `profileId`
   * names one that still exists), the fields on top, and the first candidate
   * whose harness can run where the session would be placed.
   *
   * Probing only happens when there is a choice to make: a single candidate is
   * returned as is, so the spawn reports its own reason if it cannot run.
   *
   * `pinned` is a profile as it was at some earlier moment — a workflow run
   * pins its steps' profiles when it starts (POD-6114) — and is used instead
   * of the live row, so editing the profile never changes a run in flight.
   */
  async launch(input: {
    profileId: string | null | undefined
    pinned?: AgentProfileWire | null
    fields: AgentSetupFields
    cwd: string
  }): Promise<AgentLaunch> {
    const profile =
      input.pinned ?? (input.profileId ? await this.deps.store.get(input.profileId) : null)
    const setup = resolveAgentSetup(profile, input.fields)
    const machineId = setup.machineId ? asMachineId(setup.machineId) : null
    const picked =
      setup.candidates.length > 1
        ? await pickAgentCandidate(setup.candidates, async (candidate) => {
            if (!isAgentFieldSet(candidate.harness)) return true
            try {
              await this.deps.requireRunnable({
                machineId,
                cwd: input.cwd,
                agentKind: candidate.harness,
              })
              return true
            } catch {
              return false
            }
          })
        : { candidate: setup.candidates[0] as (typeof setup.candidates)[number] }
    return {
      profile: setup.profile,
      agentKind: picked.candidate.harness,
      model: picked.candidate.model,
      effort: picked.candidate.effort,
      machineId,
      instructions: setup.instructions,
    }
  }

  /** The profile instructions for a session, or '' (the `podium:profile` source). */
  async instructionsFor(profileId: string | null | undefined): Promise<string> {
    if (!profileId) return ''
    return (await this.deps.store.get(profileId))?.instructions.trim() ?? ''
  }

  // -------------------------------------------------------------------------

  private async require(ref: string): Promise<AgentProfileWire> {
    const found = await this.find(ref)
    if (!found) {
      const names = (await this.deps.store.list()).map((p) => p.name).join(', ')
      throw new AgentProfileRefusal(
        `no agent profile '${ref}'${names ? ` (profiles: ${names})` : ''} — see \`podium profile list\``,
      )
    }
    return found
  }

  /** The deletion guard: a profile an open issue points at stays. */
  private async refuseWhileUsed(current: AgentProfileWire): Promise<void> {
    const using = await this.deps.store.openIssueSeqsUsing(current.id)
    if (using.length === 0) return
    const shown = using
      .slice(0, 10)
      .map((seq) => `#${seq}`)
      .join(', ')
    throw new AgentProfileRefusal(
      `profile '${current.name}' is used by ${using.length} open issue(s) (${shown}${using.length > 10 ? ', …' : ''}) — ` +
        'move them to another profile first (`podium issue update <id> --profile <name>`, or `--profile none`)',
    )
  }

  private async requirePerson(caller: AgentProfileCaller): Promise<void> {
    if (caller.actorSessionId) {
      throw new AgentProfileRefusal(
        'agent profiles are edited by people only; an agent may pick one with --profile. Ask the user to change it.',
      )
    }
    if ((await this.deps.roleOf(caller.userId)) !== 'admin') {
      throw new AgentProfileRefusal('only an instance admin may edit agent profiles')
    }
  }

  private async machineIdFor(ref: string | null): Promise<MachineId | null> {
    if (!ref) return null
    const machines = await this.deps.listMachines()
    const match = machineByRef(machines, ref)
    if (!match) {
      const known = machines.map((m) => m.name).join(', ')
      throw new AgentProfileRefusal(
        `no visible machine named '${ref}'${known ? ` (visible: ${known})` : ''}`,
      )
    }
    return asMachineId(match.id)
  }

  private async machineNames(): Promise<Map<string, string>> {
    try {
      return new Map((await this.deps.listMachines()).map((m) => [m.id, m.name]))
    } catch {
      return new Map()
    }
  }

  private view(profile: AgentProfileWire, names: Map<string, string>): AgentProfileView {
    return {
      ...profile,
      machineName: profile.machineId ? (names.get(profile.machineId) ?? null) : null,
    }
  }
}

const actorOf = (caller: AgentProfileCaller): string =>
  caller.actorSessionId ? `session:${caller.actorSessionId}` : caller.userId
