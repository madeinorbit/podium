import { computeTranscript } from '@podium/client-core/values'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  TranscriptComputeWorkerRequest,
  TranscriptWorkerResponse,
} from './transcript-compute.worker'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('reconstructs delta input with full-snapshot semantics through tool completion and trimming', async () => {
  const responses: TranscriptWorkerResponse[] = []
  const scope = {
    onmessage: (_event: MessageEvent<TranscriptComputeWorkerRequest>) => {},
    postMessage: (message: TranscriptWorkerResponse) => responses.push(message),
  }
  vi.stubGlobal('self', scope)
  await import('./transcript-compute.worker')
  const prompt = { id: 'prompt', role: 'user' as const, text: 'Inspect the file' }
  const call = {
    id: 'call',
    role: 'assistant' as const,
    text: '',
    toolName: 'Bash',
    toolUseId: 'use',
    toolInput: 'cat file',
  }
  const input = { verbosity: 'normal' as const, query: '', cursor: 0 }
  scope.onmessage({
    data: { id: 1, kind: 'index', indexKey: 1, input: { ...input, items: [prompt, call] } },
  } as MessageEvent)
  const result = {
    id: 'result',
    role: 'tool' as const,
    text: 'complete',
    toolName: 'Bash',
    toolUseId: 'use',
    toolResult: 'complete',
  }
  scope.onmessage({
    data: {
      id: 2,
      kind: 'delta',
      baseIndexKey: 1,
      indexKey: 2,
      changed: [result],
      order: ['prompt', 'call', 'result'],
      input,
    },
  } as MessageEvent)
  expect(responses.at(-1)).toMatchObject({
    ok: true,
    result: computeTranscript({ ...input, items: [prompt, call, result] }),
  })
  const updated = { ...result, text: 'updated', toolResult: 'updated' }
  scope.onmessage({
    data: {
      id: 3,
      kind: 'delta',
      baseIndexKey: 2,
      indexKey: 3,
      changed: [updated],
      order: ['call', 'result'],
      input,
    },
  } as MessageEvent)
  expect(responses.at(-1)).toMatchObject({
    ok: true,
    result: computeTranscript({ ...input, items: [call, updated] }),
  })
})
