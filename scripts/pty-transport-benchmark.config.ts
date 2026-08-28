/** Reproducible inputs for the PTY transport performance lane [POD-2957]. */
export const PTY_TRANSPORT_BENCHMARK_CONFIG = {
  schemaVersion: 1,
  defaultSamples: 7,
  warmupSamples: 2,
  targetBytesPerSample: 2 * 1024 * 1024,
  maxOperationsPerSample: 2_000,
  retainedBytesTarget: 8 * 1024 * 1024,
  replayBudgetBytes: 256 * 1024,
  lossyClientBudgetBytes: 256 * 1024,
  websocketCompressionMinBytes: 1024,
  websocketCompressionMaxBytes: 256 * 1024,
  payloadSizes: [
    { name: 'keystroke', bytes: 1 },
    { name: '4kib', bytes: 4 * 1024 },
    { name: '16kib', bytes: 16 * 1024 },
    { name: '64kib', bytes: 64 * 1024 },
    { name: '1mib', bytes: 1024 * 1024 },
  ],
  contentKinds: ['ascii', 'unicode', 'escape-heavy'] as const,
  viewerCounts: [1, 4] as const,
} as const
