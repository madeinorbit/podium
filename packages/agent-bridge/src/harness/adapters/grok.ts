import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_CAPABILITIES } from '@podium/protocol'
import { fileChainSource, fileIdFor, recordToItemsForKind } from '@podium/transcript'
import { grokSessionPaths, grokStateProvider, observeGrokState } from '../../agent-state/grok.js'
import { createGrokConversationProvider } from '../../discovery/providers/grok.js'
import {
  accountIdentity,
  type HarnessAdapter,
  isSet,
  type TranscriptSourceInput,
  transcriptFileExists,
} from '../adapter.js'
import { composeAgentInstructions } from '../instructions.js'

interface GrokAuthRecord {
  key?: unknown
  refresh_token?: unknown
  create_time?: unknown
  email?: unknown
  first_name?: unknown
  last_name?: unknown
}

function grokHome(homeDir: string): string {
  return process.env.GROK_HOME?.trim() || join(homeDir, '.grok')
}

function grokProfile(path: string): string | undefined {
  try {
    const file = JSON.parse(readFileSync(join(path, 'auth.json'), 'utf8')) as Record<
      string,
      GrokAuthRecord
    >
    const records = Object.values(file)
      .filter((record) => record && (record.key || record.refresh_token))
      .sort((left, right) =>
        String(right.create_time ?? '').localeCompare(String(left.create_time ?? '')),
      )
    for (const record of records) {
      const name = [record.first_name, record.last_name]
        .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
        .map((part) => part.trim())
        .join(' ')
      const account = accountIdentity(name, record.email)
      if (account) return account
    }
  } catch {
    // Keep the historical presence-only fallback below.
  }
  return undefined
}

async function chainPaths(input: TranscriptSourceInput): Promise<string[]> {
  if (!input.resumeValue) return []
  const path = grokSessionPaths({
    cwd: input.cwd,
    sessionId: input.resumeValue,
    ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
  }).chatHistoryPath
  return (await transcriptFileExists(path)) ? [path] : []
}

export const grokAdapter: HarnessAdapter = {
  kind: 'grok',
  capabilities: AGENT_CAPABILITIES.grok,
  resumeKind: 'grok-session',

  inventory: {
    binCandidates: (homeDir) => [join(homeDir, '.local', 'bin', 'grok'), 'grok'],
    detectLogin(homeDir) {
      const path = grokHome(homeDir)
      if (!existsSync(path)) return { state: 'out' }
      return { state: 'in', account: grokProfile(path) ?? 'Grok login' }
    },
  },

  launch(opts) {
    const instructions = composeAgentInstructions(opts.instructions)
    return {
      cmd: 'grok',
      args: [
        ...(opts.resume ? ['--resume', opts.resume.value] : []),
        ...(isSet(opts.model) ? ['--model', opts.model] : []),
        ...(isSet(opts.effort) ? ['--effort', opts.effort] : []),
        ...(instructions ? ['--rules', instructions] : []),
        ...(opts.initialPrompt?.trim() ? [opts.initialPrompt] : []),
      ],
      cwd: opts.cwd,
      // Grok imports compatible Claude hooks and validates their referenced env vars.
      // Give those hooks the same stable per-session identity Podium uses.
      ...(opts.podiumSessionId
        ? {
            env: {
              HARNESS_TERMINAL_ID: opts.podiumSessionId,
              CLAUDE_HARNESS_ID: opts.podiumSessionId,
            },
          }
        : {}),
    }
  },

  exec(opts) {
    const model = opts.model && opts.model !== 'auto' ? opts.model : undefined
    const sys = opts.systemPrompt?.trim() ? opts.systemPrompt.trim() : undefined
    const prompt = sys ? `${sys}\n\n---\n\n${opts.prompt}` : opts.prompt
    return { cmd: 'grok', args: ['-p', ...(model ? ['--model', model] : []), prompt] }
  },

  headless: {
    driver: 'resume-exec',
    // -s/--session-id is create-or-resume — the daemon mints the UUID on the
    // first turn, so every turn uses the same pinned invocation.
    resumeIdAllocation: 'daemon-minted-uuid',
    buildExec(opts) {
      const model = opts.model && opts.model !== 'auto' ? opts.model : undefined
      const rules = [opts.systemPrompt, opts.contextPrompt]
        .map((part) => part?.trim())
        .filter(Boolean)
        .join('\n\n')
      return {
        cmd: 'grok',
        args: [
          '-p',
          ...(opts.resumeValue
            ? ['--resume', opts.resumeValue]
            : ['--session-id', opts.sessionId ?? '']),
          ...(model ? ['--model', model] : []),
          ...(opts.permissionMode === 'auto' ? ['--permission-mode', 'auto'] : []),
          ...(rules ? ['--rules', rules] : []),
          opts.prompt,
        ],
      }
    },
  },

  state: grokStateProvider,

  // Grok has no hook channel — a polling observer discovers the session the
  // CLI creates and tails its update stream. On a fresh spawn `startedAtMs` is
  // the spawn time, so discovery skips older sibling sessions in the same cwd.
  // On reattach it's absent → observeGrokState defaults watermarkMs to 0 (no
  // floor), so the latest-by-activity session is found even if it predates
  // this daemon process start.
  observer(input, host) {
    let lease = input.observationLease
    let active: ReturnType<typeof observeGrokState> | undefined
    let stopped = false
    let pendingRebind:
      | {
          sessionId: string
          rebindId: string
          observerGeneration: number
          bindingVersion: number
        }
      | undefined

    const start = (resumeValue: string | undefined): void => {
      if (stopped) return
      active?.stop()
      const causal =
        lease?.provider === 'grok' && lease.providerSessionId && input.podiumSessionId
          ? {
              podiumSessionId: input.podiumSessionId,
              providerSessionId: lease.providerSessionId,
              bindingVersion: lease.bindingVersion,
              observerGeneration: lease.observerGeneration,
              acceptedCheckpoint: lease.acceptedCheckpoint,
              onObservation: (observation: Parameters<typeof host.onObservation>[0]) =>
                host.onObservation(observation),
            }
          : undefined
      active = observeGrokState({
        cwd: input.cwd,
        ...(input.statTick ? { statTick: input.statTick } : {}),
        ...(resumeValue ? { resumeValue } : {}),
        ...(input.homeDir ? { homeDir: input.homeDir } : {}),
        ...(input.startedAtMs !== undefined ? { startedAtMs: input.startedAtMs } : {}),
        onSessionCandidate: (grokSessionId) => {
          if (!lease) return true
          if (lease.provider !== 'grok' || !input.podiumSessionId) return false
          if (lease.providerSessionId === grokSessionId) return true
          if (!pendingRebind) {
            const rebindId = [
              'grok',
              input.podiumSessionId,
              lease.observerGeneration,
              lease.bindingVersion,
              grokSessionId,
            ].join(':')
            pendingRebind = {
              sessionId: grokSessionId,
              rebindId,
              observerGeneration: lease.observerGeneration,
              bindingVersion: lease.bindingVersion,
            }
            host.onExactProviderRebind({
              nextProviderSessionId: grokSessionId,
              resumeKind: 'grok-session',
              rebindId,
            })
          }
          return false
        },
        onSession: (grokSessionId) => {
          host.onResumeValue(grokSessionId)
          host.tailFile(
            grokSessionPaths({
              cwd: input.cwd,
              sessionId: grokSessionId,
              ...(input.homeDir ? { homeDir: input.homeDir } : {}),
            }).chatHistoryPath,
          )
        },
        ...(causal
          ? { causal }
          : lease
            ? {}
            : {
                onEvents: (events: Parameters<typeof host.onStateEvents>[0]) =>
                  host.onStateEvents(events),
              }),
      })
    }

    start(input.resumeValue)
    return {
      stop() {
        stopped = true
        active?.stop()
      },
      onObservationAck: (ack) => active?.onObservationAck?.(ack),
      onProviderRebindAck(ack) {
        const pending = pendingRebind
        if (
          !pending ||
          ack.provider !== 'grok' ||
          ack.rebindId !== pending.rebindId ||
          ack.priorObserverGeneration !== pending.observerGeneration ||
          ack.priorBindingVersion !== pending.bindingVersion ||
          ack.nextProviderSessionId !== pending.sessionId
        ) {
          return
        }
        const acceptedCandidate =
          ack.result === 'accepted' && ack.providerSessionId === pending.sessionId
        lease = {
          provider: 'grok',
          providerSessionId: ack.providerSessionId,
          bindingVersion: ack.bindingVersion,
          observerGeneration: ack.observerGeneration,
          acceptedCheckpoint: ack.checkpoint,
        }
        pendingRebind = undefined
        active?.stop()
        active = undefined
        if (acceptedCandidate) start(pending.sessionId)
        else if (ack.providerSessionId) start(ack.providerSessionId)
      },
    }
  },

  discovery: createGrokConversationProvider(),

  transcript: {
    storage: 'file-chain',
    chainPaths,
    async sourceFor(input) {
      const chain = (await chainPaths(input)).map((p) => ({ path: p, fileId: fileIdFor(p) }))
      return fileChainSource(chain, recordToItemsForKind('grok'))
    },
  },
}
