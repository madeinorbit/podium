import { expect, it } from 'vitest'
import { liveConnectionProof } from './live-connection-proof'

it('web and mobile web relay across two Chromium tabs, survive one restart, and navigate a server transfer', async () => {
  expect(await liveConnectionProof()).toEqual(
    ['web', 'mobile'].map((app) => ({
      app,
      relayed: true,
      cookieAuthenticated: true,
      reconnects: [1, 1],
      moved: true,
      claimInFragment: true,
    })),
  )
}, 120_000)
