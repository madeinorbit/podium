import { parseServerVersion } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { servedWebsiteForPage } from './served-website'

const server = parseServerVersion({
  appVersion: '0.1.1-dev.1+a55ec3d',
  web: { present: true, digest: 'a55ec3d', bundle: 'bundle+CFyX4Q_p' },
  mobileWeb: { present: true, digest: 'a55ec3d', bundle: 'bundle+a833d1a61f7a6d85a8c7fe49922500f0' },
})

const at = (origin: string, pathname: string) => ({ origin, pathname })

describe('servedWebsiteForPage', () => {
  it('gives a browser page the desktop dist it was served from', () => {
    expect(
      servedWebsiteForPage(server, 'http://podium.test:18787', at('http://podium.test:18787', '/')),
    ).toEqual(server.web)
  })

  it('gives a page under /mobile the phone export instead', () => {
    expect(
      servedWebsiteForPage(
        server,
        'http://podium.test:18787',
        at('http://podium.test:18787', '/mobile/sessions'),
      ),
    ).toEqual(server.mobileWeb)
  })

  it('tolerates a relative origin, which is how the web app is usually configured', () => {
    expect(servedWebsiteForPage(server, '', at('http://podium.test:18787', '/'))).toEqual(server.web)
  })

  /**
   * THE PAGES WHOSE ASSETS ARE SOMEWHERE ELSE. Each of these has an entry hash
   * that differs from the served one permanently and correctly, and a reload
   * cannot change it — so an answer here would be a reload offer nobody can
   * clear, which is POD-2608 arriving by a new route.
   */
  it('refuses for a desktop shell running its own baked UI', () => {
    expect(
      servedWebsiteForPage(server, 'http://podium.test:18787', at('tauri://localhost', '/')),
    ).toBeUndefined()
    expect(
      servedWebsiteForPage(server, 'http://podium.test:18787', at('https://tauri.localhost', '/')),
    ).toBeUndefined()
  })

  it('refuses for an iteration-mode page served from source in front of the server', () => {
    expect(
      servedWebsiteForPage(server, 'http://podium.test:18787', at('http://localhost:5173', '/')),
    ).toBeUndefined()
  })

  /**
   * An origin that is not absolute resolves against the page, which is the
   * honest reading: a relative `httpOrigin` IS this origin. That is the same
   * path the empty-string case above takes, and it is why this resolves rather
   * than validates.
   */
  it('reads an unparseable origin as this one rather than throwing', () => {
    expect(servedWebsiteForPage(server, 'not a url', at('http://podium.test:18787', '/'))).toEqual(
      server.web,
    )
  })

  it('passes on a server that reports no website of that kind', () => {
    const apiOnly = parseServerVersion({ appVersion: '0.4.2' })
    expect(
      servedWebsiteForPage(apiOnly, 'http://podium.test:18787', at('http://podium.test:18787', '/')),
    ).toBeUndefined()
  })
})
