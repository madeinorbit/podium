/** Numeric instrumentation only. One-millisecond buckets keep row values out
 * of the journal, and let late background reads stay outside a finished click. */
export function createLiveReadCensus(clock = () => performance.now(), retentionMs = 40_000) {
  const totals: Record<string, number> = {}
  let buckets: { at: number; counts: Record<string, number> }[] = []
  let first = 0
  return {
    record(key: string) {
      const at = Math.floor(clock())
      totals[key] = (totals[key] ?? 0) + 1
      let bucket = buckets.at(-1)
      if (bucket?.at !== at) {
        bucket = { at, counts: {} }
        buckets.push(bucket)
        while (buckets[first] && buckets[first]!.at < at - retentionMs) first++
        if (first > 4096 && first > buckets.length / 2) {
          buckets = buckets.slice(first)
          first = 0
        }
      }
      bucket.counts[key] = (bucket.counts[key] ?? 0) + 1
    },
    counts() {
      return { ...totals }
    },
    between(start: number, end: number) {
      const counts: Record<string, number> = {}
      for (let i = first; i < buckets.length; i++) {
        const bucket = buckets[i]!
        if (bucket.at > Math.floor(end)) break
        if (bucket.at < Math.floor(start)) continue
        for (const key of Object.keys(bucket.counts))
          counts[key] = (counts[key] ?? 0) + bucket.counts[key]!
      }
      return { counts, bucketMs: 1 }
    },
    get bucketCount() {
      return buckets.length - first
    },
  }
}
