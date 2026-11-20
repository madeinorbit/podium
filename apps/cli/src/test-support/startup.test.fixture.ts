import { main } from '../cli'

let release: (() => void) | undefined
process.stdin.setEncoding('utf8')
process.stdin.on('data', (input: string) => {
  if (input.includes('ping')) console.log('fixture:alive')
  if (input.includes('resume')) release?.()
})

await main(async () => ({
  async startServer({ port }) {
    console.log('fixture:starting')
    await new Promise<void>((resolve) => {
      release = resolve
    })
    console.log('fixture:boot-step-finished')
    return {
      port,
      recoveryOnly: false,
      async close() {
        console.log('fixture:server-closed')
      },
    }
  },
  isAddressInUseError: () => false,
  async startDaemon() {
    throw new Error('server-only fixture must not start a daemon')
  },
}))
