# Contributing to CHMate

Thanks for your interest in improving CHMate! Small, focused pull requests are
very welcome. This document explains how the review process works and records
the code conventions that PRs are expected to follow.

## Getting started

- **Requirements:** Node.js >= 18. No dependencies, no build step.
- **Run the app:** `node tools/serve.mjs` → http://localhost:8080 (ES modules
  can't load over `file://`).
- **Run the tests:** `npm test` — validates the bundled samples by
  self-consistency. `node test/run.mjs path/to/other.chm` tests any other file.

See the [README](README.md) for the full feature and usage documentation.

## Review process — talk to the maintainer, not the bot

Pull requests receive an automated pre-review (CodeRabbit). Treat it as a
**supporting pre-check tool** — it exists to catch mechanical issues early and
to keep things moving while the maintainer is absent. Its findings are
advisory, not decisions.

**If anything needs a maintainer decision — API contracts, behavior choices,
naming, scope — ping @Alpaq92 directly in the PR thread right away.** Don't
wait for the bot discussion to converge first, and don't stall on an unresolved
question; a direct ping is always fine and cuts the wait. Decisions made this
way get recorded here so the next contributor doesn't have to re-litigate them.

## Code conventions

- **Plain ES modules, zero dependencies, no build step.** Code runs exactly as
  written in the repo. Don't introduce tooling, transpilation, or packages.
- **Style:** 2-space indentation, semicolons, and single-statement conditionals
  without braces (`if (x) doThing();`). Match the surrounding code — its
  comment density, naming, and idiom.
- **App state:** UI state lives in the single `state` object in `src/app.js`,
  and `state.reader` is the one access path to the open CHM. Don't create
  parallel paths to the same data (e.g. by passing the reader around in return
  values).

### Decisions of record

Conventions settled in past reviews — follow them unless a maintainer says
otherwise:

- **File-open failures are reported by return value, not rejection**
  ([#1](https://github.com/Alpaq92/CHMate/pull/1)). `openBuffer()` owns the
  whole failure UX (spinner, status bar, drop error) and never rejects on a bad
  file: it resolves `true` on success and `false` on failure. `openFile()`
  forwards that result for consistency. Callers that need to know whether the
  open worked guard on the result; callers that don't can simply ignore it.
- **Optional URL query parameters treat absent and blank as equivalent**
  ([#1](https://github.com/Alpaq92/CHMate/pull/1)). Systems that build derived
  URLs often blank a parameter instead of removing it; `?zoom=` must behave
  like no `zoom` at all, never like `0`.

## Security

Every Help topic is untrusted input: it is sanitized and rendered inside a
sandboxed iframe with a strict CSP. Changes touching `src/render.js` or the
viewer frame must preserve that model — no scripts from CHM content, no
external network fetches from topics, internal resources only via `blob:` URLs.

## Tests

`test/run.mjs` covers the engine (`src/chm/`) by decoding the bundled samples
and checking self-consistency. The UI layer (`src/app.js`) has no automated
harness — exercise your change manually in the served app, and say in the PR
what you tested.
