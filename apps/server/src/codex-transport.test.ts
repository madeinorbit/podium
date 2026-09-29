import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundledDescriptorFor } from '@podium/harness/browser'
import { asMachineId, asUserId, Inventory } from '@podium/model'
import { LlmBackend } from '@podium/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCodexTransport, type CodexLoginMachineSource } from './codex-machine'
import { llmClient, LlmConfigError } from './llm'

function inventoryFor(state: 'in' | 'out') {
  return Inventory.parse({
    os: 'linux',
    arch: 'x64',
    agents: [{ kind: 'codex', installed: true, login: { state } }],
  })
}

function record(
  id: string,
  opts: { login?: 'in' | 'out'; online?: boolean; appVersion?: string | null } = {},
): CodexLoginMachineSource {
  return {
    id: asMachineId(id),
    name: id,
    revokedAt: null,
    inventory: inventoryFor(opts.login ?? 'in'),
    appVersion: opts.appVersion ?? null,
  }
}

interface Stub {
  records: CodexLoginMachineSource[]
  online: string[]
  defaultId?: string
  allow: string[]
  complete: (
    model: string,
    messages?: unknown,
    tools?: unknown,
    effort?: unknown,
    harness?: unknown,
  ) => Promise<{ ok: boolean; text?: string; toolCalls?: []; error?: string }>
}

function stubTransport(stub: Stub) {
  const calls: { machineId: string; model: string }[] = []
  const transport = createCodexTransport({
    listMachines: async () => stub.records,
    isOnline: (id) => stub.online.includes(String(id)),
    defaultMachineId: async () => (stub.defaultId ? asMachineId(stub.defaultId) : undefined),
    authorizerFor: async () => (id) =>
      stub.allow.includes(String(id)) ? undefined : 'you do not have access to use this machine',
    ownerUserId: async () => asUserId('owner-1'),
    codexComplete: async (machineId, input) => {
      calls.push({ machineId: String(machineId), model: input.model })
      return await stub.complete(input.model)
    },
  })
  return { transport, calls }
}

const codexBackend = (model = 'gpt-5.5', harnessEffort = 'auto') =>
  LlmBackend.parse({ kind: 'api', provider: 'codex', model, harnessEffort, harnessAgent: 'codex' })

describe('codex transport (POD-4750)', () => {
  let prevCodexHome: string | undefined
  let emptyHome: string

  beforeEach(() => {
    // The server's own home has NO Codex login: any file read here fails the
    // proof — the turn must succeed off the catalog machine alone.
    prevCodexHome = process.env.CODEX_HOME
    emptyHome = mkdtempSync(join(tmpdir(), 'codex-server-home-'))
    process.env.CODEX_HOME = emptyHome
  })
  afterEach(() => {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prevCodexHome
  })

  it('a codex turn succeeds via the picked machine with no server-side login file', async () => {
    const { transport, calls } = stubTransport({
      // A skewed daemon version must not stop the call: version skew never
      // gates the pick (the frame-guard arm and the no-reply deadline cover
      // daemons that truly predate the frame).
      records: [record('desk', { appVersion: 'v0.0.1-ancient' })],
      online: ['desk'],
      defaultId: 'desk',
      allow: ['desk'],
      complete: async () => ({ ok: true, text: 'hello from the daemon', toolCalls: [] }),
    })
    const client = llmClient(codexBackend(), undefined, fetch, { codexTransport: transport })
    expect(client.label).toBe('codex · gpt-5.5 (ChatGPT subscription)')
    const res = await client.complete([{ role: 'user', content: 'hi' }], [])
    expect(res).toEqual({ text: 'hello from the daemon', toolCalls: [] })
    // The backend's codex harness selected the codex login's machine.
    expect(calls).toEqual([{ machineId: 'desk', model: 'gpt-5.5' }])
  })

  it("'auto' resolves from the harness catalog, not a hard-coded slug (POD-4805)", async () => {
    // The Codex server-AI role stores model 'auto'. The slug the daemon sends
    // must come from the same model list the Codex harness uses (the bundled
    // descriptor catalog, generated from the adapter registry) — a hard-coded
    // slug here is a second list that drifts when the catalog moves, which is
    // how the server AI came to send a model the login refuses.
    const seen: string[] = []
    const transport = createCodexTransport({
      listMachines: async () => [record('desk')],
      isOnline: () => true,
      defaultMachineId: async () => asMachineId('desk'),
      authorizerFor: async () => () => undefined,
      ownerUserId: async () => asUserId('owner-1'),
      codexComplete: async (_m, input) => {
        seen.push(input.model)
        return { ok: true, text: 'ok', toolCalls: [] }
      },
    })
    const head = bundledDescriptorFor('codex')?.catalog.models[0]?.value
    expect(head).toBeTruthy()
    const auto = llmClient(codexBackend('auto'), undefined, fetch, { codexTransport: transport })
    expect(auto.label).toBe(`codex · ${head} (ChatGPT subscription)`)
    await auto.complete([{ role: 'user', content: 'hi' }], [])
    expect(seen).toEqual([head])
  })

  it('maps model default and effort like the old client did', async () => {
    const seen: { model: string; effort: string }[] = []
    const transport = createCodexTransport({
      listMachines: async () => [record('desk')],
      isOnline: () => true,
      defaultMachineId: async () => asMachineId('desk'),
      authorizerFor: async () => () => undefined,
      ownerUserId: async () => asUserId('owner-1'),
      codexComplete: async (_m, input) => {
        seen.push({ model: input.model, effort: input.effort })
        return { ok: true, text: 'ok', toolCalls: [] }
      },
    })
    // 'auto' resolves from the harness catalog (see the POD-4805 test above).
    const head = bundledDescriptorFor('codex')?.catalog.models[0]?.value
    const auto = llmClient(codexBackend('auto'), undefined, fetch, { codexTransport: transport })
    expect(auto.label).toBe(`codex · ${head} (ChatGPT subscription)`)
    await auto.complete([{ role: 'user', content: 'hi' }], [])
    // Explicit effort rides through.
    const high = llmClient(codexBackend('gpt-5.5', 'high'), undefined, fetch, {
      codexTransport: transport,
    })
    await high.complete([{ role: 'user', content: 'hi' }], [])
    expect(seen).toEqual([
      { model: head, effort: 'medium' },
      { model: 'gpt-5.5', effort: 'high' },
    ])
  })

  it('a backend naming another harness spends that login, not the codex one', async () => {
    // The harness value — not a literal in product code — selects the login.
    // A claude-harness backend against a codex-only fleet is unusable.
    const { transport } = stubTransport({
      records: [record('desk')],
      online: ['desk'],
      defaultId: 'desk',
      allow: ['desk'],
      complete: async () => ({ ok: true, text: 'must not happen', toolCalls: [] }),
    })
    const backend = LlmBackend.parse({
      kind: 'api',
      provider: 'codex',
      model: 'gpt-5.5',
      harnessEffort: 'auto',
      harnessAgent: 'claude-code',
    })
    const client = llmClient(backend, undefined, fetch, { codexTransport: transport })
    await expect(client.complete([{ role: 'user', content: 'hi' }], [])).rejects.toThrow(
      LlmConfigError,
    )
  })

  it('a daemon refusal surfaces as LlmConfigError with the daemon text', async () => {
    const { transport } = stubTransport({
      records: [record('desk')],
      online: ['desk'],
      defaultId: 'desk',
      allow: ['desk'],
      complete: async () => ({ ok: false, error: 'Codex access token is expired and Podium won\'t refresh it' }),
    })
    const client = llmClient(codexBackend(), undefined, fetch, { codexTransport: transport })
    await expect(client.complete([{ role: 'user', content: 'hi' }], [])).rejects.toThrow(
      /won't refresh/,
    )
  })

  it('codex without a transport fails closed (never a local file read)', async () => {
    expect(() => llmClient(codexBackend(), undefined)).toThrow(LlmConfigError)
  })

  it('other providers are untouched by the transport', () => {
    const { transport } = stubTransport({ records: [], online: [], allow: [], complete: async () => ({ ok: true, text: '', toolCalls: [] }) })
    expect(() => llmClient(LlmBackend.parse({ kind: 'api', provider: 'anthropic', model: 'm' }), undefined, fetch, { codexTransport: transport })).toThrow(
      /no API key configured/,
    )
    const ok = llmClient(LlmBackend.parse({ kind: 'api', provider: 'anthropic', model: 'm' }), 'sk-x', fetch, { codexTransport: transport })
    expect(ok.label).toBe('anthropic · m')
  })

  it('an unauthorized catalog login is never spent (generic error, no names)', async () => {
    const { transport } = stubTransport({
      records: [record('user-b-box')],
      online: ['user-b-box'],
      allow: [],
      complete: async () => ({ ok: true, text: 'must not happen', toolCalls: [] }),
    })
    const client = llmClient(codexBackend(), undefined, fetch, { codexTransport: transport })
    const err = await client.complete([{ role: 'user', content: 'hi' }], []).catch((e) => e)
    expect(err).toBeInstanceOf(LlmConfigError)
    expect(String(err?.message ?? err)).not.toContain('user-b-box')
  })
})
