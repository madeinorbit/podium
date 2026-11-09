/** Restartable effect lifetime; sign-out permanently prevents another start. */
export interface RuntimeService {
  start(): void
  stop(): void
  dispose(): void
}

export class ServiceLifetime {
  active = false
  private disposed = false
  private generation = 0
  private stops: (() => void)[] = []

  start(): boolean {
    if (this.active || this.disposed) return false
    this.active = true
    this.generation++
    return true
  }
  add(stop: () => void): void {
    this.stops.push(stop)
  }
  /** Pending work belongs to this start, never a later StrictMode mount. */
  guard(): () => boolean {
    const generation = this.generation
    return () => this.active && this.generation === generation
  }
  stop(): void {
    this.active = false
    this.generation++
    for (const stop of this.stops.splice(0).reverse()) stop()
  }
  dispose(): void {
    this.stop()
    this.disposed = true
  }
}
