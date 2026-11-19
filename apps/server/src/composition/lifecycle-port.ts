/** A synchronous workflow boundary whose services cannot be constructed in
 * dependency order. The composition root installs it once before hydration;
 * an early call is an explicit boot error, never an undefined service. */
export class LifecyclePort<T extends object> {
  private installed: T | undefined

  constructor(private readonly name: string) {}

  install(value: T): void {
    if (this.installed !== undefined) throw new Error(`${this.name} already installed`)
    this.installed = value
  }

  readonly read = (): T => {
    if (this.installed === undefined) throw new Error(`${this.name} used before installation`)
    return this.installed
  }
}
