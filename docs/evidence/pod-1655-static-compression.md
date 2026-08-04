# POD-1655 — static assets on the wire, before and after

Measured with curl against a server booted from this branch on port 18999
(`PODIUM_STATE_DIR` pointed at a temp dir; the live instance on 18787 was not
touched), serving a copy of the `apps/web/dist` the live instance serves, with
`scripts/precompress-dist.ts` run over it. Numbers are `Content-Length` — bytes
on the wire, not wall-clock.

## Before (= the identity response, which is byte-for-byte what shipped before)

| Asset | Accept-Encoding | Content-Encoding | Content-Length |
| --- | --- | --- | --- |
| `/assets/index-RR9HhGf3.js` | anything | *(none)* | 2,769,053 |
| `/assets/index-B_FYvwuv.css` | anything | *(none)* | 197,999 |

No `Vary`, no `Cache-Control`.

## After

| Asset | Accept-Encoding | Content-Encoding | Content-Length | Ratio |
| --- | --- | --- | --- | --- |
| `/assets/index-RR9HhGf3.js` | `gzip, br` | `br` | **621,591** | 4.5x |
| `/assets/index-RR9HhGf3.js` | `gzip` | `gzip` | **791,992** | 3.5x |
| `/assets/index-RR9HhGf3.js` | *(none)* | *(none)* | 2,769,053 | — |
| `/assets/index-B_FYvwuv.css` | `gzip, br` | `br` | **26,748** | 7.4x |
| `/assets/index-B_FYvwuv.css` | `gzip` | `gzip` | **33,276** | 5.9x |
| `/assets/index-B_FYvwuv.css` | *(none)* | *(none)* | 197,999 | — |

Every compressible response carries `Vary: Accept-Encoding`. Hashed assets carry
`Cache-Control: public, max-age=31536000, immutable`; `index.html` and `sw.js`
carry `no-cache`.

Integrity: both encoded bodies decode byte-identical to the file on disk
(`curl --compressed … | cmp -` and `… | gunzip | cmp -`).

Not compressed, deliberately: `.woff2` (checked — no `Content-Encoding`, and it
still gets the immutable cache header), `.png`, `.ico`.

Whole dist, from the build-time pre-compression pass:

    [precompress] 24 files: 5.15 MB raw -> 1.17 MB br / 1.44 MB gzip

At the ~830 KB/s the user measured over the tailnet, the main chunk goes from
~3.3s to ~0.75s (br) / ~0.95s (gzip).
