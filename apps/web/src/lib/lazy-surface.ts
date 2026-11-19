import { lazy as reactLazy } from 'react'

interface Surface {
  load: () => Promise<unknown>
  loaded: boolean
}

/** Lazy declarations register without fetching; idle warming follows new declarations. */
export class LazySurfaceRegistry {
  private readonly surfaces = new Set<Surface>()

  register<T>(load: () => Promise<T>): () => Promise<T> {
    let promise: Promise<T> | undefined
    const surface: Surface = {
      loaded: false,
      load: () => {
        promise ??= Promise.resolve()
          .then(load)
          .then(
            (module) => {
              surface.loaded = true
              return module
            },
            (error: unknown) => {
              promise = undefined
              throw error
            },
          )
        return promise
      },
    }
    this.surfaces.add(surface)
    return surface.load as () => Promise<T>
  }

  async warm(): Promise<void> {
    const attempted = new Set<Surface>()
    for (;;) {
      const batch = [...this.surfaces].filter((surface) => !attempted.has(surface))
      if (!batch.length) return
      for (const surface of batch) attempted.add(surface)
      // Importing a route evaluates its nested lazy declarations. Continue until
      // those imports have also finished, without looping on unavailable code.
      await Promise.allSettled(batch.map((surface) => surface.load()))
    }
  }

  snapshot(): { registered: number; loaded: number; unloaded: number } {
    const loaded = [...this.surfaces].filter((surface) => surface.loaded).length
    return { registered: this.surfaces.size, loaded, unloaded: this.surfaces.size - loaded }
  }
}

export const lazySurfaces = new LazySurfaceRegistry()

/** The common React.lazy declaration, including surfaces inside lazy modules. */
export const lazy: typeof reactLazy = (load) => reactLazy(lazySurfaces.register(load))
