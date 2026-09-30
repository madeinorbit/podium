import { readFileSync } from 'node:fs'
import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type AgentRuntimeState, asSessionId } from '@podium/model'
import type { AgentObservation, SessionObservationCheckpointV1 } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { acceptAgentObservation } from '../../observer.js'
// The registry loads Claude's manifest, which configures the transcript classifier a Stop reads.
import '../../registry.js'
import { ClaudeCausalObserver, claudeHookSettings } from './state-provider.js'

/**
 * CLAUDE'S TURNS WHEN A PROMPT IS TYPED WHILE IT IS BUSY (POD-4878), held to what
 * Claude Code 2.1.284 did in the POD-4862 lane
 * (docs/measurements/pod-4834-receipt-proof/claude-2.1.284/, results.md points
 * 1–2, 4, 9, 12–13).
 *
 * Each case REPLAYS one measured run: the hooks Claude posted and the transcript
 * lines it wrote, merged in the order the rig saw them, the hooks limited to the
 * ones Podium registers. The transcript lines are appended to a real file as they
 * appear, so every hook is folded against exactly the history that was on disk
 * when it arrived. Every observation must also pass the server's causal gate.
 *
 * What the runs show: `prompt_id` names a TURN. A prompt typed while Claude is
 * busy fires UserPromptSubmit at Enter carrying the RUNNING turn's id (once, A14,
 * it fired only at take-in with the prompt's own id). Taken in at a tool boundary
 * it joins the running turn. Queued behind streamed text, sent now during text,
 * or left queued when Escape stops a tool, it runs as a NEW turn with a new id and
 * no UserPromptSubmit — its `user` record (`promptSource: "queued"`) and the
 * hooks after it carry that id, and no Stop ever names the turn it replaced.
 */
const LANE = fileURLToPath(
  new URL(
    '../../../../../docs/measurements/pod-4834-receipt-proof/claude-2.1.284/tui/',
    import.meta.url,
  ),
)
const SESSION = 'db6804f3-2a9b-4aca-a640-bd3c9c68544e'

type Timed = { at: number } & (
  | { kind: 'hook'; payload: Record<string, unknown> }
  | { kind: 'record'; record: Record<string, unknown> }
)

function jsonLines(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line) => {
      try {
        const value = JSON.parse(line) as unknown
        return typeof value === 'object' && value !== null ? [value as Record<string, unknown>] : []
      } catch {
        // The rig logged one hook whose payload a SIGKILL cut to nothing (S10).
        return []
      }
    })
}

/** The hooks Podium's own settings subscribe to — nothing else ever reaches the observer. */
const REGISTERED = new Set(
  Object.keys(
    (JSON.parse(claudeHookSettings('http://127.0.0.1:1/hooks')) as { hooks: object }).hooks,
  ),
)

const MARKS = readFileSync(`${LANE}marks.txt`, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [name = '', at] = line.split(' ')
    return { name, at: Number(at) }
  })
/** A mark's time; `nth` picks a repeated mark (A1 ran twice). */
function mark(name: string, nth = 0): number {
  const found = MARKS.filter((m) => m.name === name)[nth]
  if (!found) throw new Error(`no mark ${name}#${nth}`)
  return found.at
}

const EVENTS: Timed[] = [
  ...jsonLines(`${LANE}hooks.jsonl`).flatMap((row): Timed[] => {
    const payload = row.payload as Record<string, unknown> | undefined
    return payload && REGISTERED.has(String(row.ev))
      ? [{ at: Number(row.at), kind: 'hook', payload }]
      : []
  }),
  ...jsonLines(`${LANE}transcript-watch.jsonl`).flatMap((row): Timed[] =>
    typeof row.file === 'string' && row.file.endsWith(`/${SESSION}.jsonl`)
      ? [{ at: Number(row.at), kind: 'record', record: row.rec as Record<string, unknown> }]
      : [],
  ),
  // Stable: a record and a hook seen in the same millisecond keep file order,
  // records first — the rig's seen time is only an upper bound for either.
].sort((a, b) => a.at - b.at)

const at = '2026-09-29T16:10:00.000Z'
const idle: AgentRuntimeState = {
  phase: 'idle',
  since: at,
  workingMsTotal: 0,
  nativeSubagentCount: 0,
}
const lease = {
  provider: 'claude-code' as const,
  providerSessionId: SESSION,
  bindingVersion: 3,
  observationGeneration: 7,
}

/** One compact line per observation: what a reader of the turn history sees. */
const edge = (o: AgentObservation) =>
  `${o.transitionKind} #${o.turnEpoch} ${o.priorPhase}→${o.nextPhase} ${o.providerPromptId?.slice(0, 8) ?? '-'}`

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function replayRig() {
  const root = await mkdtemp(join(tmpdir(), 'podium-claude-queued-'))
  roots.push(root)
  const transcript = join(root, `${SESSION}.jsonl`)
  await writeFile(transcript, '')
  const edges: string[] = []
  let checkpoint: SessionObservationCheckpointV1 | null = null
  let generation = 7

  const accept = (observation: AgentObservation | null) => {
    if (!observation) return
    const result = acceptAgentObservation(
      checkpoint,
      { ...lease, observationGeneration: generation },
      observation,
      at,
    )
    if (result.kind === 'rejected') {
      throw new Error(`the server gate refused ${edge(observation)}: ${result.rejectionReason}`)
    }
    checkpoint = result.checkpoint
    if (observation.provenance !== 'bootstrap') edges.push(edge(observation))
  }

  const start = async (options: { bootstrapState?: AgentRuntimeState } = {}) => {
    const offset = (await stat(transcript)).size
    const observer = new ClaudeCausalObserver({
      podiumSessionId: asSessionId('podium-queued'),
      observerGeneration: generation,
      bindingVersion: lease.bindingVersion,
      providerSessionId: SESSION,
      transcriptPath: transcript,
      bootstrapState: options.bootstrapState ?? checkpoint?.turnState ?? idle,
      bootstrapOffset: offset,
      ...(checkpoint ? { acceptedCheckpoint: checkpoint } : {}),
      now: () => at,
    })
    accept(observer.bootstrap())
    return observer
  }

  /** Feed the lane's events in [from, to) the way the daemon does: the hook's
   *  turn first, proved from the transcript, then the hook itself. */
  const replay = async (observer: ClaudeCausalObserver, from: number, to: number) => {
    for (const event of EVENTS) {
      if (event.at < from || event.at >= to) continue
      if (event.kind === 'record') {
        await appendFile(transcript, `${JSON.stringify(event.record)}\n`)
        continue
      }
      const payload = { ...event.payload, transcript_path: transcript }
      accept(await observer.observePromptTurn(payload))
      accept(await observer.observeHook(payload, (await stat(transcript)).size))
    }
  }

  /** A daemon restart: a new observer generation bound from the accepted checkpoint. */
  const restart = async () => {
    generation += 1
    return await start()
  }

  return { start, replay, restart, edges, phase: () => checkpoint?.turnState.phase }
}

describe('Claude turns for prompts typed while it is busy [POD-4878]', () => {
  it('busy in a tool: three prompts taken in at the tool boundary join the running turn', async () => {
    const rig = await replayRig()
    await rig.replay(await rig.start(), mark('A12_BUSY'), mark('A12_END'))
    expect(rig.edges).toEqual([
      'turn_opened #1 idle→working 24e5d8ab',
      'turn_terminal #1 working→idle 24e5d8ab',
    ])
  })

  it('busy in a tool across a daemon restart: the running turn’s submit hooks open no second turn', async () => {
    // What the dedupe of hook identities hid: after a restart (or 256 hooks into
    // a long turn) it no longer remembers the turn's own UserPromptSubmit, and a
    // prompt typed while busy fires one with that same id.
    const rig = await replayRig()
    await rig.replay(await rig.start(), mark('A12_BUSY'), mark('A12_Q1'))
    await rig.replay(await rig.restart(), mark('A12_Q1'), mark('A12_END'))
    expect(rig.edges).toEqual([
      'turn_opened #1 idle→working 24e5d8ab',
      'turn_terminal #1 working→idle 24e5d8ab',
    ])
  })

  it('busy in text: the three prompts queued behind the answer run as the next turn', async () => {
    const rig = await replayRig()
    await rig.replay(await rig.start(), mark('A13_BUSY'), mark('A13_END'))
    expect(rig.edges).toEqual([
      'turn_opened #1 idle→working a8d62661',
      'turn_terminal #1 working→idle a8d62661',
      // No UserPromptSubmit names it; its `user` records do, and its Stop names
      // the last of the three.
      'turn_opened #2 idle→working 71b9fd3b',
      'turn_terminal #2 working→idle 71b9fd3b',
    ])
  })

  it('Escape with a prompt queued in a tool: the queued prompt runs at once as the next turn', async () => {
    const rig = await replayRig()
    await rig.replay(await rig.start(), mark('A1_BUSY', 1), mark('A1_END'))
    expect(rig.edges).toEqual([
      'turn_opened #1 idle→working c53b895d',
      // Escape fires no Stop for the stopped turn; the queued prompt's turn replaces it.
      'turn_opened #2 working→working 1f8f32bd',
      'turn_terminal #2 working→idle 1f8f32bd',
    ])
    expect(rig.phase()).toBe('idle')
  })

  it('send now during streamed text: the cut turn is replaced by the queued prompt’s turn', async () => {
    const rig = await replayRig()
    await rig.replay(await rig.start(), mark('A6_BUSY'), mark('A6_END'))
    expect(rig.edges).toEqual([
      'turn_opened #1 idle→working 73faa584',
      'turn_opened #2 working→working f5529966',
      'turn_terminal #2 working→idle f5529966',
    ])
    expect(rig.phase()).toBe('idle')
  })

  it('send now in a tool: the prompt joins the turn; the backgrounded task’s notice is its own turn', async () => {
    const rig = await replayRig()
    await rig.replay(await rig.start(), mark('A4_BUSY'), mark('A4_END'))
    expect(rig.edges).toEqual([
      'turn_opened #1 idle→working 256d26c3',
      'turn_terminal #1 working→idle 256d26c3',
      'turn_opened #2 idle→working 1d79e0be',
      'turn_terminal #2 working→idle 1d79e0be',
    ])
  })

  it('A14: a submit hook deferred to take-in, carrying the queued prompt’s own id, opens its turn once', async () => {
    const rig = await replayRig()
    await rig.replay(await rig.start(), mark('A14_A'), mark('A14_END'))
    expect(rig.edges).toEqual([
      'turn_opened #1 idle→working 5d287fbc',
      'turn_terminal #1 working→idle 5d287fbc',
      'turn_opened #2 idle→working 56b1bf4c',
      'turn_terminal #2 working→idle 56b1bf4c',
    ])
  })
})

describe('what may open a turn no submit hook opened [POD-4878]', () => {
  async function observed() {
    const root = await mkdtemp(join(tmpdir(), 'podium-claude-queued-edge-'))
    roots.push(root)
    const transcript = join(root, 'claude-1.jsonl')
    await writeFile(transcript, '')
    const causal = new ClaudeCausalObserver({
      podiumSessionId: asSessionId('podium-1'),
      observerGeneration: 7,
      bindingVersion: 3,
      providerSessionId: 'claude-1',
      transcriptPath: transcript,
      bootstrapState: idle,
      bootstrapOffset: 0,
      now: () => at,
    })
    causal.bootstrap()
    const hook = (hook_event_name: string, extra: Record<string, unknown> = {}) => ({
      hook_event_name,
      session_id: 'claude-1',
      transcript_path: transcript,
      ...extra,
    })
    const prompt = (promptId: string, text: string, extra: Record<string, unknown> = {}) =>
      appendFile(
        transcript,
        `${JSON.stringify({ type: 'user', promptId, message: { role: 'user', content: text }, ...extra })}\n`,
      )
    const size = async () => (await stat(transcript)).size
    return { causal, hook, prompt, size }
  }

  it('a record of the named turn from before the current turn began proves nothing', async () => {
    const { causal, hook, prompt, size } = await observed()
    await prompt('p-old', 'an earlier prompt', { promptSource: 'queued' })
    await prompt('p-1', 'the current prompt')
    await causal.observeHook(hook('UserPromptSubmit', { prompt_id: 'p-1' }), await size())
    // A late hook of the earlier turn: its record is on disk, but before this turn.
    expect(await causal.observePromptTurn(hook('Stop', { prompt_id: 'p-old' }))).toBeNull()
    expect(causal.openTurnEpoch).toBe(1)
  })

  it('only a prompt Claude took from its queue proves a turn no submit hook opened', async () => {
    const { causal, hook, prompt, size } = await observed()
    await causal.observeHook(hook('UserPromptSubmit', { prompt_id: 'p-1' }), await size())
    // A typed prompt always fires its own UserPromptSubmit; its record opens nothing.
    await prompt('p-2', 'typed', { promptSource: 'typed' })
    expect(await causal.observePromptTurn(hook('Stop', { prompt_id: 'p-2' }))).toBeNull()
    await prompt('p-3', 'queued', { promptSource: 'queued' })
    expect(await causal.observePromptTurn(hook('Stop', { prompt_id: 'p-3' }))).toMatchObject({
      transitionKind: 'turn_opened',
      turnEpoch: 2,
      providerPromptId: 'p-3',
    })
  })

  it('a subagent’s hook never opens a turn, whatever turn it names', async () => {
    const { causal, hook, prompt, size } = await observed()
    await causal.observeHook(hook('UserPromptSubmit', { prompt_id: 'p-1' }), await size())
    await prompt('p-2', 'queued', { promptSource: 'queued' })
    expect(
      await causal.observePromptTurn(
        hook('PreToolUse', { prompt_id: 'p-2', agent_id: 'child', tool_use_id: 't' }),
      ),
    ).toBeNull()
    // The main agent's own hook naming it does.
    expect(
      await causal.observePromptTurn(hook('PreToolUse', { prompt_id: 'p-2', tool_use_id: 't' })),
    ).toMatchObject({ transitionKind: 'turn_opened', turnEpoch: 2, providerPromptId: 'p-2' })
  })

  it('a submit hook for a turn already opened from its record opens no second one', async () => {
    const { causal, hook, prompt, size } = await observed()
    await causal.observeHook(hook('UserPromptSubmit', { prompt_id: 'p-1' }), await size())
    await causal.observeHook(hook('Stop', { prompt_id: 'p-1' }), await size())
    await prompt('p-2', 'queued', { promptSource: 'queued' })
    expect(
      await causal.observePromptTurn(hook('PreToolUse', { prompt_id: 'p-2', tool_use_id: 't' })),
    ).toMatchObject({ transitionKind: 'turn_opened', turnEpoch: 2 })
    // A14's timing: the hook deferred to take-in, carrying the queued prompt's id.
    expect(
      await causal.observeHook(hook('UserPromptSubmit', { prompt_id: 'p-2' }), await size()),
    ).toBeNull()
    expect(causal.openTurnEpoch).toBe(2)
  })

  it('a submit hook naming the running turn spends its input origin, so the next turn keeps its own', async () => {
    const { causal, hook, size } = await observed()
    causal.recordInputOrigin('controller')
    await causal.observeHook(hook('UserPromptSubmit', { prompt_id: 'p-1' }), await size())
    // A person types into the terminal while Claude is busy.
    causal.recordInputOrigin('human')
    expect(
      await causal.observeHook(hook('UserPromptSubmit', { prompt_id: 'p-1' }), await size()),
    ).toBeNull()
    await causal.observeHook(hook('Stop', { prompt_id: 'p-1' }), await size())
    causal.recordInputOrigin('mail')
    expect(
      await causal.observeHook(hook('UserPromptSubmit', { prompt_id: 'p-3' }), await size()),
    ).toMatchObject({ transitionKind: 'turn_opened', inputOrigin: 'mail' })
  })
})
