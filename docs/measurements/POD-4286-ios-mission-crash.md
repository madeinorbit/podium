# iPhone Safari mission reload

Issue: POD-5517. Baseline: `51f59c6f34` on `integrate/4286-pilot`.

The operator reports repeated mission page reloads in iPhone Safari. Reproduction
uses an isolated iPhone simulator on `podium-apple-runner` and POD-5508's
operator-size synthetic corpus; operator data stays on its original host.

No cause has been established yet. Capture WebContent process memory and
termination logs alongside JavaScript errors and DOM counts, then compare a
throwaway ablation with the same production bundle and fixture. Changes must
preserve the visible working indicator and mission behavior. Product validation
runs in the private `~/podium-test-5517` checkout on flatblock with its own copy
of `.toolchain`. Landing is limited to `integrate/4286-pilot`.
