# Context fixture provenance

These projections come from the accepted POD-6573 `context-probe-bundle.zip` artifact.
The bundle contains native RUN responses from isolated fake providers, the full OpenAPI
schemas, source binary hashes and reproducible probes. No real provider or login was used.

`context-1.18.35.json` and `context-0.0.0-beta-18866.json` retain the measured identity,
selection, time, usage, limit and boundary fields used by context normalization. Prompt text,
response text, unrelated metadata and invented credentials were omitted. Event and native
sample IDs and numeric counters are unchanged. The executable hash identifies the admitted
native build, rather than claiming compatibility with an unmeasured version.

Request 1 uses context-a; request 2 switches to context-b; request 3 follows compaction.
Requests 4, 5 and 6 are separate native sessions testing unknown capacity, Anthropic cache
accounting and explicit zero capacity, respectively. Session totals remain cumulative and
are deliberately retained to detect accidental use as occupancy. Stable message/step copies
are the same request, not two independent quantities.

The stable Store fixture is the recorded message/part row projection. Preview Store schemas
were measured by the research task but are not declared supported by this implementation.
Additional regression mutations (invalid numbers, new variants, changed metadata or foreign
sessions) are synthetic test cases and are not native execution claims.
