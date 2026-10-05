# Startup bundle boundary

The production build now checks the always-pool application rather than its
retired off-switch design. The coordinator clarified that contract on October 5,
2026: the startup store, host, schema declarations and first-screen readers are
required; optional screen implementations remain deferred. This repair unblocks
the scalar startup comparison and does not claim a latency or bundle-size saving.

The sidebar imports `LOADING` from the constants leaf and `isSessionWorking` from
the canonical client-core predicate. The graph boundary names allowed startup
sources explicitly and rejects every other graph source, including board readers,
automation and workflow views, optional source attachments and unknown modules.
The shared pool currently owns its settings members and preferences; those are
startup dependencies rather than the deferred SettingsView component. Likewise,
the command view owns the palette-open scalar read used by its lazy boundary.

The production guard also names SettingsView, CommandPalette and board data as
deferred UI modules. Existing byte ceilings and other deferred-module checks are
unchanged. No host, registry or loading architecture was modified.

| Eager budget | Candidate `69180de663` | Existing ceiling |
| --- | ---: | ---: |
| Raw JavaScript | 1,896,482 B | 2,150,000 B |
| gzip | 608,253 B | 690,000 B |
| Brotli | 523,176 B | 595,000 B |
| Original mapped source | 7,803,572 B | 8,500,000 B |

All seven focused tests in `web-bundle-boundaries.test.ts` and
`pool-bundle-boundary.test.ts` pass on flatblock. The real Vite fixture verifies
that a required pool constructor is accepted and a planted eager board reader is
rejected. The manifest test also catches static imports omitted from HTML
preloads, unknown graph modules and incomplete manifests. The normal production
web build reports no forbidden graph source or deferred UI source. This is
focused evidence; no full suite or browser driving was used.

The failed baseline was a fresh build at `2a450299a5`. Its old guard rejected
every graph source except `loading.ts`, including required startup machinery.
The raw baseline and candidate build logs remain in `~/podium-test-5239` on
flatblock. [Candidate budget details](POD-5239-startup-scale/boundary-build.json)
retain the emitted source and chunk lists.
