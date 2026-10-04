# Palette and populated group latency

Work in progress: repeat the POD-5501 web 1× comparison on pilot
`9f9be4d761`, which includes the old-store deletion `e22a8b6bd9`.
The reference OLD build is `5e3ece5cd6`; the earlier NEW build was
`1aa0ec71f6`. The provisional eight-sample medians were 111 → 171 ms
for command-palette opening and 101 → 204 ms for populated-group expansion.

Use POD-5501's serialized semantic corpus (4,867 issues / 4,304 sessions,
seed 4443), its trusted-input / semantic-DOM / actual-Chromium-Paint collector,
and a separate capture on the operator's live data on ludovico following
the production-preview and profiling method in `POD-4286-baseline.md`.
Record the exact build and corpus for each arm. Switch off each suspected
cost before crediting a cause, then add focused regression guards.

All focused tests and fixture captures use the isolated
`~/podium-test-5514` checkout on flatblock with a copied `.toolchain` and
checkout-local dependencies. Foreground timing captures alone hold
`bench:flatblock`, with immediate release when capture ends. Landing targets
`integrate/4286-pilot` under its merge lock by fast-forward only.

Results and causal evidence are pending; this checkpoint makes no performance
or validation claim.
