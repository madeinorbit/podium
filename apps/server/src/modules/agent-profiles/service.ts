/**
 * AGENT PROFILES (POD-6107, flight deck D3/D4) — named agent setups.
 *
 * Two jobs:
 *
 *  1. The library: list/show/create/update/delete/import/export. Profiles are
 *     edited by PEOPLE only; an agent session may pick a profile (`--profile`
 *     on an issue or a spawn) but every write here refuses it.
 *  2. The launch: {@link AgentProfileService.launch} turns a profile id plus an
 *     issue's or session's own fields into the concrete harness/model/effort/
 *     machine a session starts with. The rule (profile, fields on top) is the
 *     model's `resolveAgentSetup`; what is decided HERE is only which candidate
 *     is usable, because that is a machine fact.
 */

import { randomUUID } from 'node:crypto'
import {
  agentProfileCreateInput,
  agentProfileDeleteInput,
  agentProfileImportInput,
  agentProfileUpdateInput,
} from '@podium/commands'
import {
  AgentProfileDocumentError,
  type AgentProfileWire,
  type AgentSetupFields,
  asMachineId,
  formatAgentProfileMarkdown,
  isAgentFieldSet,
  type MachineId,
  machineByRef,
  type NameableMachine,
  parseAgentProfileMarkdown,
  pickAgentCandidate,
  resolveAgentSetup,
  type SessionId,
  type UserId,
} from '@podium/model'
import type { z } from 'zod'
import type { AgentProfilesRepository } from '../../store/agent-profiles'

/** A refusal the caller can act on; the router maps it to a 4xx with this text. */
export class AgentProfileRefusal extends Error {}

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
  // Writes — people only
  // -------------------------------------------------------------------------

  async create(
    caller: AgentProfileCaller,
    raw: z.input<typeof agentProfileCreateInput>,
  ): Promise<AgentProfileView> {
    await this.requirePerson(caller)
    const input = agentProfileCreateInput.parse(raw)
    if (await this.deps.store.getByName(input.name)) {
      throw new AgentProfileRefusal(
        `a profile named '${input.name}' already exists — use \`podium profile update ${input.name}\``,
      )
    }
    const created = await this.deps.store.insert({
      id: `agp_${randomUUID()}`,
      name: input.name,
      description: input.description,
      candidates: input.candidates,
      machineId: await this.machineIdFor(input.machine ?? null),
      instructions: input.instructions.trim(),
      actor: actorOf(caller),
      now: this.deps.now(),
    })
    return this.view(created, await this.machineNames())
  }

  async update(
    caller: AgentProfileCaller,
    raw: z.input<typeof agentProfileUpdateInput>,
  ): Promise<AgentProfileView> {
    await this.requirePerson(caller)
    const input = agentProfileUpdateInput.parse(raw)
    const current = await this.require(input.ref)
    if (input.name && input.name !== current.name) {
      const clash = await this.deps.store.getByName(input.name)
      if (clash && clash.id !== current.id) {
        throw new AgentProfileRefusal(`a profile named '${input.name}' already exists`)
      }
    }
    await this.deps.store.update({
      id: current.id,
      name: input.name ?? current.name,
      description: input.description ?? current.description,
      candidates: input.candidates ?? current.candidates,
      machineId:
        input.machine === undefined
          ? (current.machineId as MachineId | null)
          : await this.machineIdFor(input.machine),
      instructions:
        input.instructions === undefined ? current.instructions : input.instructions.trim(),
      actor: actorOf(caller),
      now: this.deps.now(),
    })
    return await this.show(current.id)
  }

  async delete(
    caller: AgentProfileCaller,
    raw: z.input<typeof agentProfileDeleteInput>,
  ): Promise<{ id: string; name: string }> {
    await this.requirePerson(caller)
    const current = await this.require(agentProfileDeleteInput.parse(raw).ref)
    const using = await this.deps.store.openIssueSeqsUsing(current.id)
    if (using.length > 0) {
      const shown = using
        .slice(0, 10)
        .map((seq) => `#${seq}`)
        .join(', ')
      throw new AgentProfileRefusal(
        `profile '${current.name}' is used by ${using.length} open issue(s) (${shown}${using.length > 10 ? ', …' : ''}) — ` +
          'move them to another profile first (`podium issue update <id> --profile <name>`, or `--profile none`)',
      )
    }
    await this.deps.store.delete(current.id)
    return { id: current.id, name: current.name }
  }

  /** Create or replace profiles by name from `.podium/agents/<name>.md` texts. */
  async import(
    caller: AgentProfileCaller,
    raw: z.input<typeof agentProfileImportInput>,
  ): Promise<Array<{ name: string; action: 'created' | 'updated' }>> {
    await this.requirePerson(caller)
    const input = agentProfileImportInput.parse(raw)
    // Parse every file before writing any, so one bad file changes nothing.
    const docs = input.files.map((file) => {
      try {
        return parseAgentProfileMarkdown(file.text, file.name)
      } catch (err) {
        if (err instanceof AgentProfileDocumentError) {
          throw new AgentProfileRefusal(`${file.name ?? 'profile file'}: ${err.message}`)
        }
        throw err
      }
    })
    const seen = new Set<string>()
    for (const doc of docs) {
      if (seen.has(doc.name))
        throw new AgentProfileRefusal(`two files define the profile '${doc.name}'`)
      seen.add(doc.name)
    }
    const results: Array<{ name: string; action: 'created' | 'updated' }> = []
    for (const doc of docs) {
      const fields = {
        description: doc.description,
        candidates: doc.candidates,
        machine: doc.machine,
        instructions: doc.instructions,
      }
      if (await this.deps.store.getByName(doc.name)) {
        await this.update(caller, { ref: doc.name, ...fields })
        results.push({ name: doc.name, action: 'updated' })
      } else {
        await this.create(caller, { name: doc.name, ...fields })
        results.push({ name: doc.name, action: 'created' })
      }
    }
    return results
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
