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

it('retains independent addressed models and returns search and markdown without a graph snapshot', async () => {
  const responses: unknown[] = []
  const scope = { onmessage: (_event: MessageEvent<TranscriptComputeWorkerRequest>) => {},
    postMessage: (message: unknown) => responses.push(message) }
  vi.stubGlobal('self', scope)
  await import('./transcript-compute.worker')
  const input = { verbosity: 'normal' as const, query: 'needle', cursor: 0 }
  const send = (request: TranscriptComputeWorkerRequest) => scope.onmessage({ data: request } as MessageEvent)
  const prompt = { id: 'prompt', role: 'user' as const, text: 'needle' }
  const call = { id: 'call', role: 'tool' as const, text: '', toolName: 'Read', toolUseId: 'use' }
  send({ id: 1, kind: 'model', ownerKey: 1, indexKey: 1, items: [prompt, call], ...input })
  send({ id: 2, kind: 'model', ownerKey: 2, indexKey: 2, items: [], ...input })
  const result = { id: 'result', role: 'tool' as const, text: '', toolUseId: 'use', toolResult: 'needle result' }
  send({ id: 3, kind: 'model', ownerKey: 1, baseIndexKey: 1, indexKey: 3,
    change: { changed: [result], insertions: [{ id: 'result' }] }, ...input })
  expect(responses.at(-1)).toMatchObject({ kind: 'model', ok: true,
    search: computeTranscript({ items: [prompt, call, result], ...input }).search })
  expect(Object.keys(responses.at(-1) as object).sort()).toEqual(['id', 'kind', 'markdown', 'ok', 'search'])
  send({ id: 4, kind: 'model', ownerKey: 1, baseIndexKey: 3, indexKey: 3, ...input, verbosity: 'summary' })
  expect(responses.at(-1)).toMatchObject({ search: computeTranscript({ items: [prompt, call, result], ...input, verbosity: 'summary' }).search })
  send({ id: 5, kind: 'model', ownerKey: 2, baseIndexKey: 2, indexKey: 2, ...input })
  expect(responses.at(-1)).toMatchObject({ search: { total: 0 } })
  send({ id: 0, kind: 'forget-model', ownerKey: 1 })
  send({ id: 6, kind: 'model', ownerKey: 1, baseIndexKey: 3, indexKey: 3, ...input })
  expect(responses.at(-1)).toMatchObject({ id: 6, kind: 'model', ok: false })
})
