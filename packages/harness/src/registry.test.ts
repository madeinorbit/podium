import { HarnessAgent } from '@podium/model'
import {
  BUILTIN_HARNESS_KINDS,
  type BuiltinHarnessKind,
  HarnessId,
  isBuiltinHarnessKind,
} from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  type AgentManifest,
  type Declared,
  declaredValue,
  supported,
  unsupported,
} from './manifest.js'
import {
  AGENT_MANIFESTS,
  agentStateProviderFor,
  harnessCapabilitiesFor,
  harnessDisplayName,
  harnessResumeKind,
  harnessShowsPromptModeHints,
  harnessSupportsHandoff,
  harnessSupportsMcp,
  manifestFor,
  transcriptRecordMapperFor,
  transcriptRuntimeReaderFor,
} from './registry.js'

const CAPABILITY_FIELDS = [
  'argvPrompt',
  'effortFlag',
  'systemPromptFlag',
  'quota',
  'cloud',
  'composerScrape',
  'oscTitle',
  'subagentModelEnv',
  'promptModeHints',
  'handoff',
  'mcp',
  'observationProvider',
  'observationProtocol',
  'submitVerification',
  'exclusiveInteractiveResume',
  'promptTitleFallback',
  'mcpConfigTransport',
  'hookInstall',
] as const

/** Every AgentManifest field POD-303 lets a harness leave UNIMPLEMENTED. It must
 *  still be DECLARED — that is what these tests check. */
const DECLARED_FIELDS = [
  'exec',
  'headless',
  'handoffTranscript',
  'state',
  'observer',
  'transcript',
  'classifyBrowserOpen',
] as const satisfies readonly (keyof AgentManifest)[]

describe('agent manifest registry', () => {
  it('has one manifest per builtin harness kind with every capability field declared', () => {
    // 'New harness = one manifest file + registry entry': every BuiltinHarnessKind
    // has a manifest, keyed by its own kind, carrying ALL capability fields
    // directly (no parallel table and no partial rows sneaking in via casts).
    for (const kind of BUILTIN_HARNESS_KINDS) {
      const manifest = AGENT_MANIFESTS[kind]
      expect(manifest, `missing manifest for ${kind}`).toBeDefined()
      expect(manifest.kind).toBe(kind)
      for (const field of CAPABILITY_FIELDS) {
        expect(manifest.capabilities[field], `${kind}.capabilities.${field}`).toBeDefined()
      }
      // The irreducible fields — a harness Podium cannot spawn, or find
      // conversations for, is not a harness.
      expect(typeof manifest.launch).toBe('function')
      expect(manifest.discovery.agentKind).toBe(kind)
      expect(typeof manifest.inventory.binCandidates).toBe('function')
      expect(typeof manifest.inventory.detectLogin).toBe('function')
      expect(typeof manifest.resumeKind).toBe('string')
    }
  })

  it('declares truthful state channels in preference order', () => {
    expect(
      Object.fromEntries(
        BUILTIN_HARNESS_KINDS.map((kind) => [
          kind,
          AGENT_MANIFESTS[kind].stateChannels.map((channel) => channel.source),
        ]),
      ),
    ).toEqual({
      'claude-code': ['hook', 'classifier'],
      codex: ['hook', 'poll'],
      grok: ['poll'],
      opencode: ['poll'],
      cursor: ['poll'],
    })
    for (const manifest of Object.values(AGENT_MANIFESTS)) {
      expect(manifest.stateChannels.length, manifest.kind).toBeGreaterThan(0)
      for (let index = 1; index < manifest.stateChannels.length; index += 1) {
        const previous = manifest.stateChannels[index - 1]
        const current = manifest.stateChannels[index]
        if (!previous || !current) throw new Error(`${manifest.kind} has a channel gap`)
        expect(previous.confidence).toBeGreaterThan(current.confidence)
      }
    }
    expect(AGENT_MANIFESTS.grok.stateChannels[0]?.mechanism).toContain('turn_completed')
    expect(AGENT_MANIFESTS.codex.stateChannels[1]?.mechanism).toContain('inside this manifest')
  })

  it('attributes every provider-boundary event with source and confidence', async () => {
    const payloads: Partial<Record<BuiltinHarnessKind, unknown>> = {
      'claude-code': { hook_event_name: 'SessionStart' },
      codex: { hook_event_name: 'SessionStart' },
      grok: {
        method: 'session/update',
        params: { update: { sessionUpdate: 'user_message_chunk' } },
      },
      cursor: { role: 'user', timestamp: '2026-08-02T10:00:00.000Z' },
    }
    for (const kind of BUILTIN_HARNESS_KINDS) {
      const provider = declaredValue(AGENT_MANIFESTS[kind].state)
      expect(provider, kind).toBeDefined()
      if (!provider) throw new Error(`${kind} has no state provider`)
      const events =
        kind === 'opencode'
          ? await provider.bootEvents?.({ cwd: '/repo' })
          : await provider.translate(payloads[kind])
      expect(events?.length, kind).toBeGreaterThan(0)
      for (const event of events ?? []) {
        expect(event.source, kind).toBe(AGENT_MANIFESTS[kind].stateChannels[0]?.source)
        expect(event.confidence, kind).toBe(AGENT_MANIFESTS[kind].stateChannels[0]?.confidence)
      }
    }
  })

  it('declares every incremental-completeness field — implemented or explicitly unsupported', () => {
    // THE totality check POD-303 asks for. A field left off entirely would be
    // `undefined` here, which is neither `supported: true` nor `supported: false`
    // — so "somebody forgot a line" fails loudly instead of quietly reading as
    // "this harness genuinely does not support it".
    for (const kind of BUILTIN_HARNESS_KINDS) {
      const manifest = AGENT_MANIFESTS[kind]
      for (const field of DECLARED_FIELDS) {
        const declared: Declared<unknown> = manifest[field]
        expect(declared, `${kind}.${field} is not declared at all`).toBeDefined()
        expect(typeof declared.supported, `${kind}.${field}.supported`).toBe('boolean')
        if (declared.supported) {
          expect(declared.value, `${kind}.${field}.value`).toBeDefined()
        } else {
          // An unsupported declaration must say WHY — that reason is what
          // diagnostics and degraded UI show.
          expect(declared.reason.length, `${kind}.${field}.reason`).toBeGreaterThan(0)
        }
      }
    }
  })

  it('declares chainPaths on the file-chain harnesses and unsupported on the sqlite one', () => {
    for (const kind of BUILTIN_HARNESS_KINDS) {
      const transcript = declaredValue(AGENT_MANIFESTS[kind].transcript)
      if (!transcript) continue
      expect(transcript.storage, kind).toMatch(/^(file-chain|sqlite)$/)
      expect(typeof transcript.sourceFor, kind).toBe('function')
      // The declaration must AGREE with the storage kind: file chains have files
      // to chain, the SQLite store does not.
      expect(transcript.chainPaths.supported, `${kind} chainPaths vs storage`).toBe(
        transcript.storage === 'file-chain',
      )
      expect(transcript.recordToItems.supported, `${kind} record mapper vs storage`).toBe(
        transcript.storage === 'file-chain',
      )
      expect(typeof transcriptRecordMapperFor(kind), kind).toBe(
        transcript.storage === 'file-chain' ? 'function' : 'undefined',
      )
    }
  })

  /**
   * THE MANIFEST, NOT A SWITCH, PICKS THE RUNTIME READER (POD-1598).
   *
   * `recordRuntimeForKind` used to switch on agentKind inside @podium/transcript to
   * choose which parser read a record's model/effort/context — behaviour keyed on a
   * harness, living outside that harness's adapter. Each manifest now declares its
   * own reader and this accessor routes to it, so the routing itself is what has to
   * stay right: feed each harness the record shape only IT emits and require the
   * declared reader to produce that harness's facts.
   */
  it('routes each harness to ITS OWN declared transcript runtime reader', () => {
    expect(
      transcriptRuntimeReaderFor('claude-code')?.({
        type: 'assistant',
        effort: 'medium',
        message: { model: 'claude-opus-4-8' },
      }),
    ).toEqual({ model: 'claude-opus-4-8', effort: 'medium' })

    expect(
      transcriptRuntimeReaderFor('codex')?.({
        type: 'turn_context',
        payload: { model: 'gpt-5.7-codex', reasoning_effort: 'high' },
      }),
    ).toEqual({ model: 'gpt-5.7-codex', effort: 'high' })

    expect(transcriptRuntimeReaderFor('grok')?.({ model_id: 'grok-4.5' })).toEqual({
      model: 'grok-4.5',
    })

    // Declared unsupported (SQLite rows, not native records) and unknown ⇒ no
    // reader at all, rather than another harness's parser standing in.
    expect(transcriptRuntimeReaderFor('opencode')).toBeUndefined()
    expect(transcriptRuntimeReaderFor('not-a-kind')).toBeUndefined()
    expect(transcriptRuntimeReaderFor('shell')).toBeUndefined()
  })

  it('declares recordRuntime on every manifest, as a reader or an explicit reason', () => {
    for (const kind of BUILTIN_HARNESS_KINDS) {
      const transcript = declaredValue(AGENT_MANIFESTS[kind].transcript)
      if (!transcript) continue
      expect(transcript.recordRuntime, `${kind} recordRuntime`).toBeDefined()
      if (transcript.recordRuntime.supported) {
        expect(typeof transcript.recordRuntime.value, kind).toBe('function')
      } else {
        expect(
          transcript.recordRuntime.reason.length,
          `${kind} recordRuntime reason`,
        ).toBeGreaterThan(0)
      }
    }
  })

  it('declares buildExec on the child-process headless drivers and unsupported on the SDK one', () => {
    for (const kind of BUILTIN_HARNESS_KINDS) {
      const headless = declaredValue(AGENT_MANIFESTS[kind].headless)
      if (!headless) continue
      expect(headless.driver, kind).toBeDefined()
      expect(headless.resumeIdAllocation, kind).toBeDefined()
      expect(headless.outputFormat, kind).toBeDefined()
      expect(headless.buildExec.supported, `${kind} buildExec vs driver`).toBe(
        headless.driver !== 'claude-sdk',
      )
    }
  })

  it('classifies own-domain browser opens: oauth paths are logins, the rest links', () => {
    const claude = declaredValue(AGENT_MANIFESTS['claude-code'].classifyBrowserOpen)
    expect(claude).toBeDefined()
    expect(claude?.(new URL('https://claude.ai/oauth/authorize?client_id=x'))).toEqual({
      intent: 'login',
    })
    expect(claude?.(new URL('https://claude.ai/code/artifact/abc?via=auto_preview'))).toEqual({
      intent: 'link',
    })
    expect(claude?.(new URL('https://example.com/'))).toBeUndefined()

    const codex = declaredValue(AGENT_MANIFESTS.codex.classifyBrowserOpen)
    expect(codex?.(new URL('https://auth.openai.com/oauth/authorize'))).toEqual({ intent: 'login' })
    expect(codex?.(new URL('https://chatgpt.com/share/x'))).toEqual({ intent: 'link' })
    expect(codex?.(new URL('https://example.com/'))).toBeUndefined()
  })

  it('shell and unknown kinds have no manifest', () => {
    expect(manifestFor('shell')).toBeUndefined()
    expect(manifestFor('not-a-kind')).toBeUndefined()
    expect(agentStateProviderFor('shell')).toBeUndefined()
    expect(harnessCapabilitiesFor('shell')).toBeUndefined()
    expect(transcriptRecordMapperFor('not-a-kind')).toBeUndefined()
  })

  it('derives capability answers from manifests and degrades unknown ids closed', () => {
    expect(BUILTIN_HARNESS_KINDS.filter((kind) => harnessSupportsHandoff(kind))).toEqual([
      'claude-code',
      'codex',
    ])
    expect(BUILTIN_HARNESS_KINDS.filter((kind) => harnessShowsPromptModeHints(kind))).toEqual([
      'claude-code',
    ])
    expect(harnessSupportsHandoff('future-harness')).toBe(false)
    expect(harnessShowsPromptModeHints('future-harness')).toBe(false)
    expect(BUILTIN_HARNESS_KINDS.filter((kind) => harnessSupportsMcp(kind))).toEqual([
      'claude-code',
      'codex',
    ])
    expect(harnessDisplayName('claude-code')).toBe('Claude')
    expect(harnessDisplayName('future-harness')).toBe('future-harness')
    expect(harnessResumeKind('codex')).toBe('codex-thread')
    expect(harnessResumeKind('future-harness')).toBeUndefined()
  })
})

describe('open HarnessId vs closed BuiltinHarnessKind (POD-303)', () => {
  it('parses an unknown harness id off the wire instead of rejecting the frame', () => {
    // The wire type is OPEN: a newer peer may name a harness this build has never
    // heard of, and the frame must still parse. Rejecting it would take a whole
    // session offline over a name.
    expect(HarnessId.safeParse('some-harness-from-2027').success).toBe(true)
    // …but it is NOT admitted to the closed registry, so nothing looks up a
    // manifest for it by accident.
    expect(isBuiltinHarnessKind('some-harness-from-2027')).toBe(false)
  })

  it('degrades an unknown harness to "no manifest" rather than a wrong default', () => {
    // The failure this guards: a lookup that fell through to a default entry would
    // make an unknown harness silently behave like whichever CLI was the default
    // — e.g. spawn `claude` for a harness that is not Claude. `undefined` forces
    // the caller to degrade instead.
    expect(manifestFor('some-harness-from-2027')).toBeUndefined()
    expect(agentStateProviderFor('some-harness-from-2027' as never)).toBeUndefined()
    for (const kind of BUILTIN_HARNESS_KINDS) {
      expect(manifestFor(kind)).toBe(AGENT_MANIFESTS[kind])
    }
  })

  it('keeps the closed set and the wire enum in agreement', () => {
    // BuiltinHarnessKind exists only for registry totality; today it IS
    // HarnessAgent. If they ever diverge, the registry keeps this name — and this
    // test is where that divergence has to be made deliberate.
    expect([...BUILTIN_HARNESS_KINDS]).toEqual([...HarnessAgent.options])
    expect(Object.keys(AGENT_MANIFESTS).sort()).toEqual([...BUILTIN_HARNESS_KINDS].sort())
  })

  it('accepts a minimal manifest — launch and discovery only — and degrades the rest', () => {
    // POD-303's incremental completeness, exercised. The real assertion is that
    // this OBJECT LITERAL TYPECHECKS against AgentManifest: it proves a new
    // BuiltinHarnessKind can land in stages, with the irreducible fields
    // implemented and every other axis explicitly declared unsupported, without
    // implementing all of them at once.
    const fictional = 'fictional-harness' as BuiltinHarnessKind
    const minimal: AgentManifest = {
      // Cast only because 'fictional-harness' is deliberately NOT in the closed
      // set — the point is that the SHAPE is satisfiable, not that a sixth
      // harness exists.
      kind: fictional,
      displayName: 'Fictional',
      capabilities: { ...AGENT_MANIFESTS['claude-code'].capabilities },
      resumeKind: 'fictional-session',
      inventory: {
        binCandidates: () => ['fictional'],
        detectLogin: () => ({ state: 'unknown' }),
      },
      launch: (opts) => ({ cmd: 'fictional', args: [], cwd: opts.cwd }),
      discovery: {
        id: 'fictional',
        agentKind: fictional,
        defaultRoots: () => [],
        listRoot: async () => ({ entries: [] }),
        summarizeFile: async () => ({ ok: false, reason: 'unsupported' }),
        scanRoot: async () => ({ summaries: [] }),
        loadConversation: async () => {
          throw new Error('unsupported')
        },
      } as unknown as AgentManifest['discovery'],
      exec: unsupported('no one-shot mode'),
      headless: unsupported('no headless mode yet'),
      state: unsupported('no state instrumentation yet'),
      stateChannels: [],
      observer: unsupported('no native store to observe yet'),
      transcript: unsupported('no transcript reader yet'),
      classifyBrowserOpen: unsupported('no known domains'),
      handoffTranscript: unsupported('no cross-machine handoff yet'),
    }

    // Every degraded axis reads as explicitly-unsupported WITH a reason — never as
    // an accidental undefined, and never as another harness's behavior.
    for (const field of DECLARED_FIELDS) {
      const declared: Declared<unknown> = minimal[field]
      expect(declared.supported, field).toBe(false)
      expect(declaredValue(declared), field).toBeUndefined()
    }
    // …while the irreducible half genuinely works.
    expect(minimal.launch({ cwd: '/tmp' })).toEqual({ cmd: 'fictional', args: [], cwd: '/tmp' })
  })

  it('supported() round-trips a value and unsupported() carries its reason', () => {
    expect(declaredValue(supported(42))).toBe(42)
    const gap = unsupported('not yet')
    expect(declaredValue(gap)).toBeUndefined()
    expect(gap.supported === false && gap.reason).toBe('not yet')
  })
})
