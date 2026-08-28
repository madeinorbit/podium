# Grok A5 validation

This directory contains the corrected A5 re-drive owned by POD-3025. The
authoritative reading is readings/a5-current-3cd8.json, with the concise raw
transcript in readings/a5-current-3cd8.txt.

The earlier dded76d9c reading in POD-2927 reported a tool-result loss, but it
left a real protocol permission ask unanswered and therefore never exercised
the terminal result boundary. The corrected 3cd8fa16a run answered that ask
with allow-once and proved the call/result pair live and after reload.
