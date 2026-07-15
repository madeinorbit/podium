export interface CodexReadinessSample {
  ready: boolean
  hash: string
}

/** Require a ready composer to remain unchanged through a quiet interval. */
export class CodexReadinessBoundary {
  private stableHash: string | undefined
  private stableSince = 0

  constructor(private readonly quietMs: number) {}

  observe(sample: CodexReadinessSample, now: number): boolean {
    if (!sample.ready) {
      this.reset()
      return false
    }
    if (sample.hash !== this.stableHash) {
      this.stableHash = sample.hash
      this.stableSince = now
      return false
    }
    return now - this.stableSince >= this.quietMs
  }

  private reset(): void {
    this.stableHash = undefined
    this.stableSince = 0
  }
}
