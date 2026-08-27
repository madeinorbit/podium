/**
 * PTY binary/base64 transport measurement [POD-2957].
 *
 * This is a standalone heavy lane: it amplifies codec work, retains encoded
 * messages for a memory proxy, and writes machine-specific evidence on request.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { cpus, freemem, hostname, platform, release, totalmem } from 'node:os'
import { dirname } from 'node:path'
import { constants, deflateRawSync } from 'node:zlib'
import { PTY_TRANSPORT_BENCHMARK_CONFIG as CONFIG } from './pty-transport-benchmark.config'

type ContentKind = (typeof CONFIG.contentKinds)[number]
type Plane = 'client-output' | 'daemon-output' | 'client-input' | 'daemon-input'
type Encoding = 'base64-json' | 'binary-envelope'
type Distribution = {
  samples: number
  min: number
  p50: number
  p95: number
  max: number
  mean: number
  standardDeviation: number
  coefficientOfVariation: number
}
type Timing = {
  operationsPerSample: number
  wallUsPerOperation: Distribution
  cpuUsPerOperation: Distribution
  throughputMiBPerSecond: Distribution
  checksum: number
}
type Representation = {
  plane: Plane
  content: ContentKind
  payload: string
  payloadBytes: number
  encoding: Encoding
  base64PayloadBytes: number
  serializedBytes: number
  envelopeBytes: number | null
  compressionSelected: boolean
  compressedMessageBytes: number
  websocketWireBytes: number
}

const SESSION_ID = '00000000-0000-4000-8000-000000002957'
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function parseArgs(): Map<string, string> {
  const parsed = new Map<string, string>()
  for (const raw of process.argv.slice(2)) {
    if (!raw.startsWith('--')) throw new Error('unknown positional argument: ' + raw)
    const [key, ...rest] = raw.slice(2).split('=')
    parsed.set(key!, rest.join('=') || 'true')
  }
  return parsed
}

function percentile(sorted: readonly number[], q: number): number {
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0
}

function summarize(values: readonly number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b)
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  const standardDeviation = Math.sqrt(variance)
  return {
    samples: values.length,
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? 0,
    mean,
    standardDeviation,
    coefficientOfVariation: mean === 0 ? 0 : standardDeviation / mean,
  }
}

function payloadOf(kind: ContentKind, byteLength: number): Uint8Array {
  const seeds: Record<ContentKind, Uint8Array> = {
    ascii: encoder.encode('podium terminal output 0123456789\r\n'),
    unicode: encoder.encode('Zażółć gęślą jaźń — こんにちは — 🧪\r\n'),
    'escape-heavy': encoder.encode('\x1b[38;5;39m$ printf "hello"\x1b[0m\r\n\x1b[2K\x1b[1G'),
  }
  const seed = seeds[kind]
  const out = Buffer.allocUnsafe(byteLength)
  for (let offset = 0; offset < byteLength; offset += seed.byteLength) {
    out.set(seed.subarray(0, Math.min(seed.byteLength, byteLength - offset)), offset)
  }
  return out
}

function metadataFor(plane: Plane): Record<string, unknown> {
  if (plane === 'client-output') {
    return { v: 1, type: 'ptyOutput', sessionId: SESSION_ID, seq: 42, epoch: 3 }
  }
  if (plane === 'daemon-output') {
    return { v: 1, type: 'ptyOutput', sessionId: SESSION_ID, sourceFrames: 4 }
  }
  if (plane === 'client-input') return { v: 1, type: 'ptyInput', sessionId: SESSION_ID }
  return {
    v: 1,
    type: 'ptyInput',
    sessionId: SESSION_ID,
    inputOrigin: 'human',
    attribution: { actor: { kind: 'user', id: 'benchmark-user' } },
  }
}

function legacyMessageFor(plane: Plane, payload: Uint8Array): Record<string, unknown> {
  const data = Buffer.from(payload).toString('base64')
  if (plane === 'client-output') {
    return { type: 'outputFrame', sessionId: SESSION_ID, seq: 42, epoch: 3, data }
  }
  if (plane === 'daemon-output') {
    return { type: 'agentFrameBatch', sessionId: SESSION_ID, frames: [data] }
  }
  if (plane === 'client-input') return { type: 'input', sessionId: SESSION_ID, data }
  return { type: 'input', sessionId: SESSION_ID, inputOrigin: 'human', data }
}

function encodeLegacy(plane: Plane, payload: Uint8Array): Uint8Array {
  return encoder.encode(JSON.stringify(legacyMessageFor(plane, payload)))
}

function decodeLegacy(plane: Plane, wire: Uint8Array): Uint8Array {
  const parsed = JSON.parse(decoder.decode(wire)) as { data?: string; frames?: string[] }
  const data = plane === 'daemon-output' ? parsed.frames?.join('') : parsed.data
  if (typeof data !== 'string') throw new Error('legacy ' + plane + ' payload missing')
  return Buffer.from(data, 'base64')
}

function encodeEnvelope(plane: Plane, payload: Uint8Array): Uint8Array {
  const metadata = encoder.encode(JSON.stringify(metadataFor(plane)))
  if (metadata.byteLength > 16 * 1024) throw new Error('metadata exceeds 16 KiB')
  const out = Buffer.allocUnsafe(4 + metadata.byteLength + payload.byteLength)
  out.writeUInt32BE(metadata.byteLength, 0)
  out.set(metadata, 4)
  out.set(payload, 4 + metadata.byteLength)
  return out
}

function decodeEnvelope(wire: Uint8Array): Uint8Array {
  if (wire.byteLength < 4) throw new Error('truncated envelope header')
  const view = Buffer.from(wire.buffer, wire.byteOffset, wire.byteLength)
  const metadataLength = view.readUInt32BE(0)
  if (metadataLength > 16 * 1024 || metadataLength > wire.byteLength - 4) {
    throw new Error('invalid envelope metadata length')
  }
  const metadata = JSON.parse(decoder.decode(wire.subarray(4, 4 + metadataLength))) as {
    v?: number
    type?: string
  }
  if (metadata.v !== 1 || !['ptyInput', 'ptyOutput'].includes(metadata.type ?? '')) {
    throw new Error('unsupported envelope metadata')
  }
  return wire.subarray(4 + metadataLength)
}

function codec(plane: Plane, encoding: Encoding) {
  return encoding === 'base64-json'
    ? {
        encode: (payload: Uint8Array) => encodeLegacy(plane, payload),
        decode: (wire: Uint8Array) => decodeLegacy(plane, wire),
      }
    : { encode: (payload: Uint8Array) => encodeEnvelope(plane, payload), decode: decodeEnvelope }
}

function checksumBytes(bytes: Uint8Array): number {
  return (bytes.byteLength * 31 + (bytes[0] ?? 0) * 17 + (bytes.at(-1) ?? 0)) >>> 0
}

function measure(
  operation: () => Uint8Array,
  payloadBytes: number,
  operationsPerSample: number,
  samples: number,
): Timing {
  let checksum = 0
  const run = () => {
    for (let index = 0; index < operationsPerSample; index += 1) {
      checksum = (checksum + checksumBytes(operation())) >>> 0
    }
  }
  for (let warmup = 0; warmup < CONFIG.warmupSamples; warmup += 1) run()
  const wall: number[] = []
  const cpu: number[] = []
  const throughput: number[] = []
  for (let sample = 0; sample < samples; sample += 1) {
    const cpuStart = process.cpuUsage()
    const startedAt = performance.now()
    run()
    const elapsedMs = performance.now() - startedAt
    const used = process.cpuUsage(cpuStart)
    wall.push((elapsedMs * 1_000) / operationsPerSample)
    cpu.push((used.user + used.system) / operationsPerSample)
    throughput.push(
      (payloadBytes * operationsPerSample) / (1024 * 1024) / Math.max(elapsedMs / 1_000, 1e-9),
    )
  }
  return {
    operationsPerSample,
    wallUsPerOperation: summarize(wall),
    cpuUsPerOperation: summarize(cpu),
    throughputMiBPerSecond: summarize(throughput),
    checksum,
  }
}

function websocketHeaderBytes(payloadBytes: number, masked: boolean): number {
  return 2 + (payloadBytes < 126 ? 0 : payloadBytes <= 0xffff ? 2 : 8) + (masked ? 4 : 0)
}

function compressedWire(wire: Uint8Array, plane: Plane) {
  const selected =
    wire.byteLength >= CONFIG.websocketCompressionMinBytes &&
    wire.byteLength <= CONFIG.websocketCompressionMaxBytes
  let messageBytes = wire.byteLength
  if (selected) {
    const compressed = deflateRawSync(wire, { flush: constants.Z_SYNC_FLUSH })
    const trailer = Buffer.from([0, 0, 0xff, 0xff])
    messageBytes = compressed.subarray(-4).equals(trailer)
      ? compressed.byteLength - trailer.byteLength
      : compressed.byteLength
  }
  const masked = plane === 'client-input' || plane === 'daemon-output'
  return {
    selected,
    messageBytes,
    websocketBytes: messageBytes + websocketHeaderBytes(messageBytes, masked),
  }
}

function forceGc(): void {
  const scope = globalThis as typeof globalThis & { Bun?: { gc?: (full?: boolean) => void } }
  scope.Bun?.gc?.(true)
}

function retainedAllocation(
  plane: Plane,
  encoding: Encoding,
  payloadName: string,
  payload: Uint8Array,
): Record<string, unknown> {
  const retainedMessages = Math.max(
    1,
    Math.min(2_000, Math.ceil(CONFIG.retainedBytesTarget / payload.byteLength)),
  )
  const selected = codec(plane, encoding)
  forceGc()
  const before = process.memoryUsage()
  let retained: Uint8Array[] = []
  let checksum = 0
  for (let index = 0; index < retainedMessages; index += 1) {
    const wire = selected.encode(payload)
    checksum = (checksum + checksumBytes(wire)) >>> 0
    retained.push(wire)
  }
  forceGc()
  const after = process.memoryUsage()
  const result = {
    plane,
    encoding,
    payload: payloadName,
    payloadBytes: payload.byteLength,
    retainedMessages,
    heapBytesPerMessage: Math.max(0, after.heapUsed - before.heapUsed) / retainedMessages,
    externalBytesPerMessage: Math.max(0, after.external - before.external) / retainedMessages,
    arrayBufferBytesPerMessage:
      Math.max(0, after.arrayBuffers - before.arrayBuffers) / retainedMessages,
    rssBytesPerMessage: Math.max(0, after.rss - before.rss) / retainedMessages,
    checksum,
  }
  retained = []
  forceGc()
  return result
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right))
}

function semanticParity() {
  const failures: string[] = []
  let cases = 0
  const payloads = [
    encoder.encode('ascii\x1b[31m\r\n'),
    encoder.encode('split: 🧪 and こんにちは'),
    Uint8Array.from([0, 3, 9, 13, 27, 91, 50, 74, 255]),
    encoder.encode('\x1b[200~large paste\nwith unicode 🧪\x1b[201~'),
  ]
  for (const plane of ['client-output', 'daemon-output', 'client-input', 'daemon-input'] as const) {
    for (const encoding of ['base64-json', 'binary-envelope'] as const) {
      for (const payload of payloads) {
        cases += 1
        const selected = codec(plane, encoding)
        if (!equalBytes(payload, selected.decode(selected.encode(payload)))) {
          failures.push([plane, encoding, payload.byteLength].join('/'))
        }
      }
    }
  }
  const split = encoder.encode('🧪')
  for (const encoding of ['base64-json', 'binary-envelope'] as const) {
    cases += 1
    const selected = codec('client-output', encoding)
    const joined = Buffer.concat([
      selected.decode(selected.encode(split.subarray(0, 2))),
      selected.decode(selected.encode(split.subarray(2))),
    ])
    if (!equalBytes(split, joined)) failures.push('split-codepoint/' + encoding)
  }
  return { cases, passed: cases - failures.length, failures }
}

function mixedVersions(): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = []
  for (const topology of ['all-in-one', 'remote-daemon'] as const) {
    for (const direction of ['output', 'input'] as const) {
      for (const hop of ['client-server', 'server-daemon'] as const) {
        for (const sender of ['old', 'new'] as const) {
          for (const receiver of ['old', 'new'] as const) {
            const direct =
              topology === 'all-in-one' &&
              hop === 'server-daemon' &&
              sender === 'new' &&
              receiver === 'new'
            const selected = direct
              ? 'direct-bytes'
              : sender === 'new' && receiver === 'new'
                ? 'binary-envelope'
                : 'base64-json'
            results.push({ topology, direction, hop, sender, receiver, selected, supported: true })
          }
        }
      }
    }
  }
  return results
}

function replayScenario(encoding: Encoding, viewers: number, payload: Uint8Array) {
  const legacyStorageBytes = Buffer.from(payload).toString('base64').length
  const perEntryBudget = encoding === 'base64-json' ? legacyStorageBytes : payload.byteLength
  const retainedFrames = Math.max(1, Math.floor(CONFIG.replayBudgetBytes / perEntryBudget))
  const selected = codec('client-output', encoding)
  const startedAt = performance.now()
  let deliveredWireBytes = 0
  let checksum = 0
  for (let frame = 0; frame < retainedFrames; frame += 1) {
    for (let viewer = 0; viewer < viewers; viewer += 1) {
      const wire = selected.encode(payload)
      deliveredWireBytes += wire.byteLength
      checksum = (checksum + checksumBytes(wire)) >>> 0
    }
  }
  return {
    encoding,
    viewers,
    frameRawBytes: payload.byteLength,
    retainedFrames,
    retainedRawBytes: retainedFrames * payload.byteLength,
    storageAccountingBytes: retainedFrames * perEntryBudget,
    deliveredWireBytes,
    deliveryWallMs: performance.now() - startedAt,
    checksum,
  }
}

function slowClientScenario(encoding: Encoding, payload: Uint8Array) {
  const wireBytes = codec('client-output', encoding).encode(payload).byteLength
  let buffered = 0
  let accepted = 0
  let dropped = 0
  let maxBuffered = 0
  for (let frame = 0; frame < 2_000; frame += 1) {
    buffered = Math.max(0, buffered - Math.floor(wireBytes / 4))
    if (buffered > CONFIG.lossyClientBudgetBytes) {
      dropped += 1
      continue
    }
    accepted += 1
    buffered += wireBytes
    maxBuffered = Math.max(maxBuffered, buffered)
  }
  return {
    encoding,
    payloadBytes: payload.byteLength,
    wireBytes,
    accepted,
    dropped,
    maxBufferedBytes: maxBuffered,
    budgetBytes: CONFIG.lossyClientBudgetBytes,
    bounded: maxBuffered <= CONFIG.lossyClientBudgetBytes + wireBytes,
  }
}

function inputPipeline(payload: Uint8Array, encoding: Encoding, samples: number) {
  const client = codec('client-input', encoding)
  const daemon = codec('daemon-input', encoding)
  const values: number[] = []
  let checksum = 0
  for (let warmup = 0; warmup < CONFIG.warmupSamples; warmup += 1) {
    const atServer = client.decode(client.encode(payload))
    daemon.decode(daemon.encode(atServer))
  }
  for (let sample = 0; sample < samples; sample += 1) {
    const startedAt = performance.now()
    const atServer = client.decode(client.encode(payload))
    const atDaemon = daemon.decode(daemon.encode(atServer))
    values.push((performance.now() - startedAt) * 1_000)
    checksum = (checksum + checksumBytes(atDaemon)) >>> 0
  }
  return { latencyUs: summarize(values), checksum }
}

function headlineComparison(representations: Representation[]) {
  const cells = [
    ['client-output', '4kib', 'ascii'],
    ['client-output', '64kib', 'escape-heavy'],
    ['client-input', 'keystroke', 'ascii'],
    ['client-input', '64kib', 'unicode'],
  ] as const
  return cells.flatMap(([plane, payload, content]) => {
    const legacy = representations.find(
      (item) =>
        item.plane === plane &&
        item.payload === payload &&
        item.content === content &&
        item.encoding === 'base64-json',
    )
    const binary = representations.find(
      (item) =>
        item.plane === plane &&
        item.payload === payload &&
        item.content === content &&
        item.encoding === 'binary-envelope',
    )
    if (!legacy || !binary) return []
    return [
      {
        plane,
        payload,
        content,
        rawPayloadBytes: legacy.payloadBytes,
        base64PayloadBytes: legacy.base64PayloadBytes,
        base64ExpansionPercent: (legacy.base64PayloadBytes / legacy.payloadBytes - 1) * 100,
        legacySerializedBytes: legacy.serializedBytes,
        binaryEnvelopeBytes: binary.serializedBytes,
        serializedReductionPercent: (1 - binary.serializedBytes / legacy.serializedBytes) * 100,
        legacyCompressedWireBytes: legacy.websocketWireBytes,
        binaryCompressedWireBytes: binary.websocketWireBytes,
        compressedWireReductionPercent:
          (1 - binary.websocketWireBytes / legacy.websocketWireBytes) * 100,
      },
    ]
  })
}

function markdown(report: Record<string, any>): string {
  const rows = report.comparison.headline
    .map(
      (row: Record<string, number | string>) =>
        '| ' +
        [
          row.plane,
          String(row.payload) + '/' + String(row.content),
          row.rawPayloadBytes,
          row.base64PayloadBytes,
          row.legacySerializedBytes,
          row.binaryEnvelopeBytes,
          Number(row.serializedReductionPercent).toFixed(1) + '%',
          row.legacyCompressedWireBytes,
          row.binaryCompressedWireBytes,
        ].join(' | ') +
        ' |',
    )
    .join('\n')
  const unsupported = report.unsupported
    .map((item: { signal: string; reason: string }) => '- ' + item.signal + ': ' + item.reason)
    .join('\n')
  return [
    '# PTY transport ' + report.label + ' report',
    '',
    '- Measured: ' + report.measuredAt,
    '- SHA: \x60' + report.git.sha + '\x60',
    '- Base SHA: \x60' + report.git.baseSha + '\x60',
    '- Candidate SHA: ' +
      (report.git.candidateSha ? '\x60' + report.git.candidateSha + '\x60' : 'not integrated'),
    '- Command: \x60' + report.command + '\x60',
    '- Runtime: Bun ' +
      report.environment.bun +
      ', ' +
      report.environment.platform +
      ' ' +
      report.environment.release +
      ', ' +
      report.environment.cpu,
    '- Samples: ' +
      report.config.samples +
      ' measured + ' +
      report.config.warmupSamples +
      ' warm-up per codec cell',
    '- Semantic parity: **' +
      (report.semanticParity.failures.length === 0 ? 'PASS' : 'FAIL') +
      '** (' +
      report.semanticParity.passed +
      '/' +
      report.semanticParity.cases +
      ')',
    '',
    '## Headline representation and wire results',
    '',
    '| Plane | Payload | Raw B | Base64 B | Legacy JSON B | Binary envelope B | Serialized reduction | Legacy compressed WS B | Binary compressed WS B |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    rows,
    '',
    'The 25% reduction is the raw payload relative to its base64 representation. Compressed WebSocket bytes are reported independently; no speedup threshold was preselected.',
    '',
    '## Coverage',
    '',
    '- ' +
      report.representations.length +
      ' representation cells across client/daemon input/output, five sizes, and three content kinds.',
    '- ' +
      report.codecs.length +
      ' encode/decode timing cells with p50, p95, standard deviation, and coefficient of variation.',
    '- One/four viewer fan-out, legacy/raw replay accounting, slow-client boundedness, all-in-one/remote topology selection, and old/new sender/receiver combinations.',
    '- Single-key and large bracketed-paste codec-pipeline latency proxies. Browser input-to-paint remains a separately reported real-boundary measurement.',
    '',
    '## Unsupported or deferred signals',
    '',
    unsupported || '- None',
    '',
  ].join('\n')
}

function gitValue(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

async function main(): Promise<void> {
  const args = parseArgs()
  const samples = Number(args.get('samples') ?? CONFIG.defaultSamples)
  if (!Number.isInteger(samples) || samples < 3 || samples > 50) {
    throw new Error('--samples must be an integer between 3 and 50')
  }
  const sha = gitValue(['rev-parse', 'HEAD'])
  const label = args.get('label') ?? 'measurement'
  const baseSha = args.get('base-sha') ?? sha
  const candidateSha = args.get('candidate-sha') ?? (label === 'candidate' ? sha : null)

  const representations: Representation[] = []
  const codecs: Array<Record<string, unknown>> = []
  const allocations: Array<Record<string, unknown>> = []
  const fanout: Array<Record<string, unknown>> = []
  const replay: Array<Record<string, unknown>> = []
  const backpressure: Array<Record<string, unknown>> = []
  const inputPipelineLatency: Array<Record<string, unknown>> = []

  for (const size of CONFIG.payloadSizes) {
    for (const content of CONFIG.contentKinds) {
      const payload = payloadOf(content, size.bytes)
      const operations = Math.max(
        1,
        Math.min(
          CONFIG.maxOperationsPerSample,
          Math.ceil(CONFIG.targetBytesPerSample / size.bytes),
        ),
      )
      for (const plane of [
        'client-output',
        'daemon-output',
        'client-input',
        'daemon-input',
      ] as const) {
        for (const encoding of ['base64-json', 'binary-envelope'] as const) {
          const selected = codec(plane, encoding)
          const wire = selected.encode(payload)
          const compressed = compressedWire(wire, plane)
          representations.push({
            plane,
            content,
            payload: size.name,
            payloadBytes: size.bytes,
            encoding,
            base64PayloadBytes: Buffer.from(payload).toString('base64').length,
            serializedBytes: wire.byteLength,
            envelopeBytes: encoding === 'binary-envelope' ? wire.byteLength : null,
            compressionSelected: compressed.selected,
            compressedMessageBytes: compressed.messageBytes,
            websocketWireBytes: compressed.websocketBytes,
          })
          codecs.push({
            plane,
            content,
            payload: size.name,
            payloadBytes: size.bytes,
            encoding,
            phase: 'encode',
            ...measure(() => selected.encode(payload), size.bytes, operations, samples),
          })
          codecs.push({
            plane,
            content,
            payload: size.name,
            payloadBytes: size.bytes,
            encoding,
            phase: 'decode',
            ...measure(() => selected.decode(wire), size.bytes, operations, samples),
          })
        }
      }
    }
  }

  for (const size of [CONFIG.payloadSizes[1], CONFIG.payloadSizes[3], CONFIG.payloadSizes[4]]) {
    const payload = payloadOf('escape-heavy', size.bytes)
    for (const encoding of ['base64-json', 'binary-envelope'] as const) {
      allocations.push(retainedAllocation('client-output', encoding, size.name, payload))
    }
  }

  const fanoutPayload = payloadOf('escape-heavy', 64 * 1024)
  for (const viewers of CONFIG.viewerCounts) {
    for (const encoding of ['base64-json', 'binary-envelope'] as const) {
      const selected = codec('client-output', encoding)
      const timing = measure(
        () => {
          const frames: Uint8Array[] = []
          for (let viewer = 0; viewer < viewers; viewer += 1) {
            frames.push(selected.encode(fanoutPayload))
          }
          return Buffer.concat(frames)
        },
        fanoutPayload.byteLength * viewers,
        16,
        samples,
      )
      fanout.push({
        encoding,
        viewers,
        payloadBytes: fanoutPayload.byteLength,
        wallUsP50: timing.wallUsPerOperation.p50,
        wallUsP95: timing.wallUsPerOperation.p95,
        cpuUsP50: timing.cpuUsPerOperation.p50,
        throughputMiBPerSecondP50: timing.throughputMiBPerSecond.p50,
        coefficientOfVariation: timing.wallUsPerOperation.coefficientOfVariation,
      })
    }
  }

  const replayPayload = payloadOf('unicode', 4 * 1024)
  for (const viewers of CONFIG.viewerCounts) {
    for (const encoding of ['base64-json', 'binary-envelope'] as const) {
      replay.push(replayScenario(encoding, viewers, replayPayload))
    }
  }
  for (const encoding of ['base64-json', 'binary-envelope'] as const) {
    backpressure.push(slowClientScenario(encoding, replayPayload))
  }

  for (const [name, payload] of [
    ['single-key', encoder.encode('x')],
    [
      'large-bracketed-paste',
      encoder.encode('\x1b[200~' + 'paste 🧪\n'.repeat(6_000) + '\x1b[201~'),
    ],
  ] as const) {
    for (const encoding of ['base64-json', 'binary-envelope'] as const) {
      const latencySamples = Math.max(samples * 10, 50)
      inputPipelineLatency.push({
        name,
        encoding,
        payloadBytes: payload.byteLength,
        samples: latencySamples,
        ...inputPipeline(payload, encoding, latencySamples),
      })
    }
  }

  const parity = semanticParity()
  if (parity.failures.length > 0) {
    throw new Error('semantic parity failed: ' + parity.failures.join(', '))
  }
  if (backpressure.some((cell) => cell.bounded !== true)) {
    throw new Error('slow-client model exceeded the existing lossy send bound')
  }

  let baselineRun: Record<string, unknown> | null = null
  const comparePath = args.get('compare')
  if (comparePath) {
    const baseline = JSON.parse(readFileSync(comparePath, 'utf8')) as Record<string, any>
    baselineRun = {
      sha: baseline.git.sha,
      measuredAt: baseline.measuredAt,
      label: baseline.label,
    }
  }

  const report: Record<string, any> = {
    schemaVersion: CONFIG.schemaVersion,
    label,
    measuredAt: new Date().toISOString(),
    git: {
      sha,
      branch: gitValue(['branch', '--show-current']),
      baseSha,
      candidateSha,
    },
    command: 'bun run test:perf:pty-transport -- ' + process.argv.slice(2).join(' '),
    environment: {
      hostname: hostname(),
      platform: platform(),
      release: release(),
      architecture: process.arch,
      cpu: cpus()[0]?.model ?? 'unknown',
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
      freeMemoryBytesAtStart: freemem(),
      bun: Bun.version,
      nodeCompatibility: process.version,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    config: { ...CONFIG, samples },
    representations,
    codecs,
    allocations,
    fanout,
    replay,
    backpressure,
    mixedVersions: mixedVersions(),
    semanticParity: parity,
    inputPipelineLatency,
    unsupported: [
      {
        signal: 'real browser input-to-paint',
        reason:
          'This hermetic lane reports codec-pipeline latency; the final candidate run must add the single real browser/xterm paint-boundary measurement.',
      },
      {
        signal: 'native bridge internal wire bytes',
        reason:
          'React Native may retain its documented base64 fallback and does not expose internal WebSocket byte accounting.',
      },
      {
        signal: 'production transport counters on the pre-binary SHA',
        reason:
          'Low-cardinality binary/base64 counters are owned by the transport implementation issues and do not exist on the baseline commit.',
      },
    ],
    comparison: {
      headline: headlineComparison(representations),
      baselineRun,
      note: 'Raw/base64 expansion is a representation fact; compressed WebSocket savings are measured separately and may be neutral or negative.',
    },
  }

  const encoded = JSON.stringify(report, null, 2) + '\n'
  const outPath = args.get('out')
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true })
    await Bun.write(outPath, encoded)
    console.log('PTY transport raw report: ' + outPath)
  } else {
    process.stdout.write(encoded)
  }
  const reportPath = args.get('report')
  if (reportPath) {
    mkdirSync(dirname(reportPath), { recursive: true })
    await Bun.write(reportPath, markdown(report))
    console.log('PTY transport summary report: ' + reportPath)
  }
}

await main()
