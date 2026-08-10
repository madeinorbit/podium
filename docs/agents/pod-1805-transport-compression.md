# Transport compression coverage

This matrix audits application-owned network delivery paths and records the compression decision for each one. “Wire proof” means a real Bun process was observed at the HTTP or RFC 6455 framing layer; unit configuration assertions do not count.

| Surface | Payloads and consumers | Compression decision | Guardrails | Wire proof |
| --- | --- | --- | --- | --- |
| Web and desktop static shell | HTML, JS, CSS, JSON, SVG, manifests, maps, and text served to browsers and the Tauri webview | Keep the existing build-time Brotli/gzip siblings, with asynchronous cached fallback compression | 1 KiB floor; content-type allowlist; PNG/JPEG/GIF/WebP/AVIF, fonts, media, WASM, and other precompressed formats stay identity; 64 MiB fallback cache | A raw HTTP client observed `Content-Encoding: gzip` and decoded the served HTML; the real Chromium desktop client negotiated the compressed socket |
| Mobile web shell | Expo HTML/JS/CSS/JSON/SVG/text under `/mobile` | Use the same static negotiator; Expo builds without siblings use its bounded asynchronous fallback | Same floor/type exclusions/cache; cross-origin-isolation headers remain unchanged | A raw HTTP client decoded the gzip mobile shell; the built Expo app rendered under the Pixel browser profile and negotiated the compressed socket |
| Dynamic API | tRPC batches, MCP JSON-RPC, version/setup/auth/maintenance JSON, and plugin responses | Gzip eligible buffered text/JSON responses at the server boundary | 1 KiB floor, 8 MiB ceiling, at most two active jobs, level 4, identity when saturated, `no-transform`, range, HEAD, 204/304, or an existing encoding; only keep output with a material size win | Raw HTTP response headers and gzip bytes from a real Bun process |
| File and text delivery | Checkout assets and immutable issue-artifact snapshots under `/files` | Compress text, JSON, JavaScript, CSS, XML, and SVG responses through the dynamic HTTP policy | Images, archives, fonts, audio/video, PDF, WASM, and other already-compressed types stay identity; sandbox/CSP/nosniff and cache headers are preserved; `Vary: Accept-Encoding` added only to eligible responses | A real artifact `.txt` response carried gzip bytes while a same-sized artifact PNG remained identity |
| Human-client WebSocket | Feed/bootstrap, metadata, transcript, terminal, presence, and control frames used unchanged by web, mobile, and desktop clients | Move the upgrade boundary to native `Bun.serve` and negotiate RFC 7692 `permessage-deflate`; request compression only for eligible outbound frames | 1 KiB floor; precompressed/base64 image envelopes excluded; existing 16 MiB control and 256 KiB lossy backpressure budgets retained; native compressor/decompressor uses Bun's smallest 3 KiB mode; accepted inbound frame size stays bounded | Raw RFC 6455 traffic carried `Sec-WebSocket-Extensions`, RSV1, and a smaller payload; the built desktop and Expo mobile clients negotiated and decoded the protocol |
| Daemon/realtime WebSocket | Auth handshake, daemon control, file/text RPC, workspace/handoff, discovery, transcript, and realtime frames | Use the same native negotiated extension; server sends use the same per-frame eligibility policy and Bun/standards clients decode transparently | Tiny handshakes/control stay identity; base64 image/file envelopes with precompressed MIME types stay identity; daemon liveness/backpressure limits remain per-plane | Real daemon handshake plus compressed daemon-bound frame observed at RFC 6455 framing level |
| In-process local daemon link | Same-host control messages passed directly in all-in-one mode | No compression | There is no network serialization or wire transfer to save; compression would add pure CPU cost | Direct-link test/architecture evidence, not a wire claim |
| Daemon hook ingest | Loopback/Unix-socket hook POSTs and bounded JSON acknowledgements | No response compression | Responses are normally `{}` and bounded by a 3 s hook deadline; request bodies are capped at 2 MiB. Compressing the tiny acknowledgement would waste CPU | Audit exclusion |
| Agent relay HTTP | Loopback agent RPC requests/results | Dynamic payload remains uncompressed | Local-only hop, 1 MiB request cap, and normal responses are small; the large result’s subsequent daemon/server leg is the compressible network boundary | Audit exclusion |
| Update artifacts | Prebuilt `.tar.gz`/application-gzip bundles | No additional compression | Already compressed and signature-addressed; recompression wastes CPU and changes signed bytes | Identity `Content-Encoding` audit |
| Telemetry relay | Cloudflare Worker acknowledgements and error text | No compression work in the Bun server | Responses are empty or tiny, requests are capped at 8 KiB, and this surface runs on Cloudflare rather than Bun | Audit exclusion |
| Outbound third-party/API fetches | Telegram, telemetry, update downloads, and optional integrations | No server response encoding change | Podium is the client, not the owner of the remote response transport; update downloads are already compressed | Audit exclusion |

## Security and resource posture

Authenticated HTTP and WebSocket data can contain user text next to server state. Cross-origin WebSocket upgrades are rejected, authenticated HTTP is cookie-gated, and cookies remain `SameSite=Lax`; therefore an unrelated origin cannot supply chosen plaintext and observe authenticated compressed responses. A same-origin script that can do so can already read the response itself. Plain `ws://` and `http://` expose payload contents directly to an on-path observer, so compression does not create the confidentiality boundary; operators requiring transport confidentiality must terminate TLS.

RFC 7692 context takeover improves ratio but retains history per connection. Bun does not expose `server_no_context_takeover` negotiation controls, so the native handler uses Bun's smallest 3 KiB compressor/decompressor mode and connection lifetimes remain bounded by the existing liveness sweeps. HTTP compression is stateless per response. Both policies skip tiny/already-compressed data, keep current backpressure limits, and put explicit byte and concurrency ceilings around compression work.

## Acceptance measurements

The final real-Bun probe measured the following conserved quantities. Sizes are encoded bytes/original bytes; CPU is process CPU consumed around the operation, while wall time is only supporting context from the shared host.

| Path | Measurement |
| --- | --- |
| Desktop static HTML | 1,078 / 112,471 bytes (99.0% reduction) |
| Mobile static HTML | 751 / 112,043 bytes (99.3% reduction) |
| Artifact text / PNG control | 718 / 112,000 bytes; PNG 65,536 / 65,536 identity |
| Dynamic JSON HTTP | 5,483 / 86,900 bytes (93.7% reduction), 8.80 ms process CPU, 13.69 ms wall |
| Daemon WebSocket frame | 7,575 / 112,164 bytes (93.2% reduction), 7.21 ms synchronous send CPU |
| Human-client WebSocket publication | 5,201 / 16,505 bytes (68.5% reduction) |

The same probe asserted identity framing for tiny HTTP, daemon hello, realtime pong, PNG, and base64 image-upload messages. HTTP compression runs on zlib's asynchronous worker path, admits at most two jobs, reads at most 8 MiB from a clone, and serves identity while saturated; WebSocket compression remains synchronous inside Bun's native send, so the 1 KiB floor, 32 MiB ceiling, precompressed exclusions, and existing backpressure termination bound its event-loop and memory exposure.

## Validation

- `bun run typecheck` passed across all 23 package tasks.
- Focused native HTTP/WebSocket unit tests and the raw-wire Bun integration test passed.
- `bun run test:acceptance` passed (1 test), and `bun run test:e2e` passed (36 tests across 10 files).
- The built desktop shell passed its Chromium interaction check; the built Expo mobile shell passed under the Pixel browser profile. Both real browser clients negotiated and decoded `permessage-deflate`.
- `bun run test` was run, but the default lane stops at the pre-existing session-mint trust drift reproduced on clean local `main` and tracked in POD-1811. The full integration lane likewise reaches the pre-existing updater exit-code failure tracked in POD-1812, and the complete server package task reaches four clean-main ratchet failures tracked together in POD-1814; the transport-specific and cross-boundary lanes above are green.
