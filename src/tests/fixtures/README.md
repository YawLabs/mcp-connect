# Test fixtures

## `foundry-corpus.json` -- NOT COMMITTED (the routing gate is DORMANT)

`src/tests/foundry-routing.test.ts` is a BM25 routing-regression gate that
consumes a corpus of **real harvested dispatches**. That corpus has never been
produced, so the gate has never run. It reports itself as a `todo` plus a
stderr banner on every `npm test`; it does not fail `npm test` (there is no CI
by policy -- the local gates `release.sh` runs are the release check).

**The fixture is deliberately absent, not missing by accident.** Read the
"Do not hand-write this file" section before you try to make the gate green.

### What the gate measures

Each corpus entry is a real `(redacted token bag -> chosen namespace)` pair,
where `chosen` is the server the FULL pipeline (BM25 + rerank + health +
learning + sampling) actually routed that intent to. The gate re-ranks the
snapshot catalog with **BM25 only** and asserts `chosen` is still in the top-3
for at least `FOUNDRY_TOP3_FLOOR` of the weighted entries.

It is a **regression gate, not a correctness oracle**: it does not claim
`chosen` was the objectively right server. It claims that a change to BM25
weights or tokenization has not dropped real-world choices out of contention.
See the header of `src/foundry-corpus.ts` for the full framing.

The sibling gate `src/tests/routing-quality.test.ts` already covers the
hand-written case (14 authored intents against a 15-server authored catalog).
This gate exists only to add the thing that file cannot have: real traffic.

### How to produce the fixture (maintainer procedure)

1. **Read the privacy scope first** -- the header of `src/foundry.ts`. Intents
   are redacted (structured PII and secret-shaped tokens are stripped, and the
   surviving tokens are sorted so word order is destroyed), but *ordinary words
   that happen to be sensitive survive*: personal names, company names, ticket
   prose. Do not harvest on a machine whose intents routinely carry those.

2. **Opt in to the harvest.** Set `YAW_MCP_FOUNDRY=1` (or `true`) in the
   environment of whatever runs the server, then use `dispatch` normally.
   Harvesting is off by default and no other value enables it.

   Traces append to `~/.yaw-mcp/foundry.jsonl` (one JSON line per dispatch:
   redacted tokens, candidate namespaces, chosen namespace). The file is
   capped at 5 MiB; past that, new traces are dropped rather than rotated.
   Collect enough dispatches that the corpus is worth gating on -- a handful
   of entries makes a floor that measures noise.

3. **Export.** From the repo root, with a local `bundles.json` present (the
   export snapshots the server catalog so the corpus replays in CI without a
   live config):

   ```
   yaw-mcp foundry export
   ```

   Defaults: `--out src/tests/fixtures/foundry-corpus.json`, `--cap 500`
   (stratified by `chosen`, so rare servers survive the cap). `--json` emits a
   machine-readable summary. Exit codes (the table at the top of
   `src/foundry-cmd.ts`): `0` corpus written; `1` any runtime failure -- no
   harvest file, no parseable traces, or no usable entries after folding
   (every trace's `chosen` is unknown to the local server catalog, or all
   tokens were empty); `2` bad argv, the CLI-wide usage-error code.

4. **Review before committing.** Skim the token bags in the written JSON. They
   are what ships to the repo forever. Anything you would not put in a commit
   message should not be there -- drop those entries or re-harvest.

5. **Commit it.** The gate activates on the next `npm test` with no code
   change: the test file loads this path at module scope and branches on it.

6. **Ratchet the floor.** The export prints the measured BM25-floor top-1 and
   top-3 for the corpus it just wrote. Raise `FOUNDRY_TOP3_FLOOR` in
   `src/foundry-corpus.ts` toward (just under) the measured top-3, so the gate
   tightens with the data instead of rubber-stamping a later regression.

### Do not hand-write this file

A synthetic corpus at this path would be worse than the honest skip:

- **It would test nothing new.** Hand-authored `(query -> expected server)`
  pairs scored against a hand-authored catalog is exactly
  `routing-quality.test.ts`. Written into the corpus shape it measures whatever
  BM25 already does -- circular, and green by construction.
- **It would manufacture confidence.** The gate's whole premise is real
  traffic. A green "regression gate over REAL harvested dispatches" that never
  saw a dispatch is a false signal in every CI summary that reads it.
- **It would be indistinguishable from real data later.** The corpus format
  carries no provenance field. A future reader cannot tell an invented token
  bag from a harvested one.
- **It would be clobbered silently.** This path is the default `--out` of
  `yaw-mcp foundry export`, so the first real export overwrites it without
  warning.

If you want to exercise the gate's machinery without harvesting, the
self-check at the bottom of `src/tests/foundry-routing.test.ts` already does
that with an inline probe corpus that never touches disk.

### If the fixture exists but the gate still says it is dormant

It does not: a fixture that exists and fails `validateCorpus` is a hard test
FAILURE, not a skip. The likely causes are a bumped `FOUNDRY_CORPUS_VERSION`
(re-export), a truncated or hand-edited file, or an empty `entries` array.
