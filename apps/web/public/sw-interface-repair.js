/* Loaded by the generated worker, including when the page is an older build. */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      let target
      try {
        const response = await fetch(new URL('podium-build.json', self.registration.scope), {
          cache: 'no-store',
          signal: AbortSignal.timeout(3000),
        })
        if (!response.ok) return
        target = (await response.json()).bundleVersion
      } catch {
        return
      }
      if (typeof target !== 'string') return
      await self.clients.claim()
      const clients = await self.clients.matchAll({ type: 'window' })
      await Promise.all(
        clients.map(async (client) => {
          const url = new URL(client.url)
          if (url.origin !== self.location.origin || url.pathname.startsWith('/mobile')) return
          const answer = await new Promise((resolve) => {
            const channel = new MessageChannel()
            const timer = setTimeout(() => {
              channel.port1.close()
              resolve(undefined)
            }, 3000)
            channel.port1.onmessage = (message) => {
              clearTimeout(timer)
              channel.port1.close()
              resolve(message.data)
            }
            client.postMessage({ type: 'podium:interface-build', target }, [channel.port2])
          })
          if (answer?.bundle === target || answer?.mayReload === false) return
          // Do not hold activation open on a navigation waiting for activation.
          void client.navigate(client.url).catch(() => {})
        }),
      )
    })(),
  )
})
