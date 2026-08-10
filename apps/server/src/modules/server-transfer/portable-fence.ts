export interface PortableStateWriteFence {
  assertWritable(): void
  runWriter<T>(writer: () => Promise<T>): Promise<T>
  runWriterSync<T>(writer: () => T): T
}

export class PortableStateFence implements PortableStateWriteFence {
  private held = false
  private activeWriters = 0
  private readonly waiters = new Set<() => void>()

  assertWritable(): void {
    if (this.held) throw new Error('portable state is fenced for server transfer')
  }

  async runWriter<T>(writer: () => Promise<T>): Promise<T> {
    this.assertWritable()
    this.activeWriters += 1
    try {
      return await writer()
    } finally {
      this.writerFinished()
    }
  }

  runWriterSync<T>(writer: () => T): T {
    this.assertWritable()
    this.activeWriters += 1
    try {
      return writer()
    } finally {
      this.writerFinished()
    }
  }

  async acquire(): Promise<void> {
    if (this.held) throw new Error('portable state fence is already held')
    this.held = true
    if (this.activeWriters === 0) return
    await new Promise<void>((resolve) => this.waiters.add(resolve))
  }

  release(): void {
    this.held = false
  }

  private writerFinished(): void {
    this.activeWriters -= 1
    if (this.activeWriters !== 0 || !this.held) return
    for (const resolve of this.waiters) resolve()
    this.waiters.clear()
  }
}
