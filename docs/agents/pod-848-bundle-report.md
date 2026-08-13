# Lean browser package entrypoints

All readings are production Vite builds from the post-POD-849 commit. Raw sizes are filesystem
bytes; gzip uses level 9 and Brotli uses quality 11. The eager graph is the entry script plus every
JavaScript module preload in `index.html`. Parsed source bytes are the `sourcesContent` bytes in the
corresponding source maps.

## Eager graph

| Reading | POD-849 baseline | Pure-module mechanics | Focused entrypoints |
| --- | ---: | ---: | ---: |
| Raw | 2,320,240 B | 2,281,356 B (-38,884) | 2,153,190 B (-128,166; -167,050 total) |
| Gzip | 688,028 B | 676,557 B (-11,471) | 639,527 B (-37,030; -48,501 total) |
| Brotli | 569,183 B | 559,271 B (-9,912) | 529,098 B (-30,173; -40,085 total) |
| Parsed source | 7,547,559 B | 7,417,720 B (-129,839) | 7,244,184 B (-173,536; -303,375 total) |

The first step removes the ownership matrix's module-init late binding and marks only the pure model
and commands packages as side-effect-free. It earns a real reduction, but source maps still place
`annotations/matrix.ts` in the eager entry because the client-side historical-secret scrub imported
the policy-enriched settings classification.

The focused step separates path-to-tier mechanics from policy classification, routes the scrub and
write planner through that smaller model, and gives web imports a browser model surface. The final
source maps contain no `packages/model/src/annotations/matrix.ts` entry in the eager graph or in any
other browser JavaScript chunk. `@podium/commands` remains absent from eager sources, as it was after
POD-849.

## Settings chunk

| Reading | POD-849 baseline | Pure-module mechanics | Focused entrypoints |
| --- | ---: | ---: | ---: |
| Raw | 298,425 B | 121,553 B (-176,872) | 95,737 B (-25,816; -202,688 total) |
| Gzip | 85,313 B | 36,537 B (-48,776) | 27,254 B (-9,283; -58,059 total) |
| Brotli | 69,895 B | 31,068 B (-38,827) | 23,457 B (-7,611; -46,438 total) |
| Parsed source | 899,493 B | 315,279 B (-584,214) | 251,088 B (-64,191; -648,405 total) |

The baseline Settings source map carried 28 command modules, including account, approval, fleet,
mail, issue, session, superagent, and workflow registries. Side-effect metadata lets Rolldown reduce
that to `settings/contracts.ts` plus `settings/write-plan.ts`. The focused
`@podium/commands/settings-write-plan` entrypoint removes the remaining contract registry and its
policy prose; the final chunk contains only `settings/write-plan.ts` and the small
`settings/write-policy.ts` delivery table from that package.

## Regression guard

`scripts/web-bundle-budget.ts` reads the production HTML, JavaScript, and hidden source maps. The web
build now fails if the ownership matrix returns to any browser chunk, command sources enter the eager
graph, unrelated command registries enter Settings, or the eager/Settings raw, gzip, Brotli, and
parsed-source budgets are exceeded.
