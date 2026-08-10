import { expect, test } from '@playwright/test'
import { openHome } from './_harness'

test('desktop and mobile browser clients negotiate the native compressed socket', async ({
  page,
  isMobile,
}) => {
  await openHome(page)
  if (isMobile) await expect(page.getByRole('button', { name: 'Tray' })).toBeVisible()
  else await expect(page.locator('.desktop-shell')).toBeVisible()

  const proof = await page.evaluate(
    () =>
      new Promise<{ extensions: string; messageType: string }>((resolve, reject) => {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
        const socket = new WebSocket(`${protocol}//${location.host}/client`)
        const timeout = window.setTimeout(() => {
          socket.close()
          reject(new Error('browser compression probe timed out'))
        }, 10_000)
        socket.onerror = () => reject(new Error('browser compression probe failed'))
        socket.onopen = () => socket.send(JSON.stringify({ type: 'ping' }))
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as { type?: string }
          if (message.type !== 'pong') return
          window.clearTimeout(timeout)
          const extensions = socket.extensions
          socket.close()
          resolve({ extensions, messageType: message.type })
        }
      }),
  )

  expect(proof.extensions).toContain('permessage-deflate')
  expect(proof.messageType).toBe('pong')
})
