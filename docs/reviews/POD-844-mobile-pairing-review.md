# Mobile pairing design review

Date: 2026-08-12  
Reviewer: independent Claude Opus 5, high effort  
Verdict: **Approve with changes**

The reviewer traced the proposed design against the current daemon enrollment, auth session, mobile provider, Expo web export, and server static-routing code. It approved the core architecture: reuse the versioned join envelope and one-shot grant primitive, keep mobile clients out of daemon enrollment, require two-sided approval for secret-bearing QR pairing, and isolate local state by server profile plus user.

It identified seven implementation blockers. All seven are resolved in the revised proposal:

1. **Native versus web-mobile:** `/mobile` now keeps using its page origin as an implicit profile and never shows native server onboarding. Scanner/profile switching is native-only; a pair fragment can begin the browser ceremony.
2. **Existing `?server=` override:** retained as ephemeral development/test behavior, never persisted as a user profile.
3. **Node-only codec:** the shared envelope moves out of the `Buffer`-based runtime module into an RN-safe package, with runtime re-export for compatibility.
4. **Session labels and renewal:** mobile uses `label='mobile'` plus explicit device metadata and an explicit renewal rule, rather than overloading the label with a unique device name.
5. **Native credential delivery:** the design chooses a SecureStore bearer and extends the shared HTTP/WebSocket credential resolver; browsers keep HttpOnly cookies. A boundary spike gates the rest of implementation.
6. **Open mode:** its QR is URL-only, with no meaningless approval or session issuance.
7. **Pending claim and phrase details:** the browser polls a named status endpoint, and the proposal now specifies exact HMAC inputs and word mapping.

The revision also clarifies principal-scoped replica erasure, the web QR renderer dependency, Tailscale `100.64.0.0/10` HTTP behavior, camera/deep-link cleanup, server-restart expiry, independent throttling, version-mismatch recovery, and remote versus self-revocation.

The reviewer additionally suggested using `https://<server>/mobile#pair=<envelope>` as the primary QR. The proposal adopts it: the stock camera works without an installed app, the native in-app scanner can read the same QR, and the fragment is excluded from the HTTP request line. The custom `podium://` scheme remains a secondary bridge.

No implementation was started during review or revision.
