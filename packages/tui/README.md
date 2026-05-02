# `@copilot-ralph-extension/tui` — Live TUI for ralph_loop

> Terminal visualizer for live `ralph_loop` / `self_improve` /
> `grow_project` runs (issue #22). Tails a JSONL event stream the
> loop handler writes to `~/.copilot/ralph/runs/<runId>/events.jsonl`
> and renders a live timeline, detail pane, and controls.

The TUI is **opt-in** — the core extension keeps working with zero
new runtime deps. You only need this package when you actually want
to *watch* a loop run.

## Subcommands

```text
ralph-tui list [--json] [--limit N]  Show recorded runs (newest first).
                                     `--json` emits the index as a JSON
                                     array for scripting/dashboards;
                                     `--limit N` caps the table.
ralph-tui replay <runId>             Print every event in a past run.
ralph-tui watch [runId] [--plain]    Tail the given run (or the most
                                     recent one if omitted) in real time.
ralph-tui doctor                     Diagnose the runs directory + writer
                                     wiring (permissions, malformed
                                     JSONL, stale lockfiles, broken
                                     symlinks).
ralph-tui prune [--older-than D]     Remove runs older than DURATION
        [--dry-run]                  (e.g. 30d / 12h / 5m; default 30d).
                                     `--dry-run` lists what would go
                                     without touching the filesystem.
ralph-tui stats                      Aggregate stats across the run
                                     index (run count, total iterations,
                                     p50/p95 durations, top SDLC tools).
ralph-tui where                      Print the resolved runs root path
                                     so a contributor can `cd` into it.
ralph-tui --help     | -h            Show usage.
ralph-tui --version  | -V            Print the ralph-tui package version.
```

`--plain` is **auto-enabled when stdout is not a TTY** so CI logs and
`asciinema rec` outputs stay grep-friendly and ANSI-free. The
interactive Ink-rendered watch UI (Header / Timeline / DetailPane /
Controls — see [docs/cli-stack.md](../../docs/cli-stack.md)) ships in
the next slice; if its module isn't installed, `watch` falls back to
`--plain` automatically.

## Quick start

```sh
# 1. From the repo root, no install needed for plain mode:
node packages/tui/bin/tui.mjs --help

# 2. List recorded runs (writes from extension/events-emit.mjs end up
#    in $RALPH_EVENTS_DIR or ~/.copilot/ralph/runs).
node packages/tui/bin/tui.mjs list

# 3. Replay a finished run as plain log lines.
node packages/tui/bin/tui.mjs replay self_improve-1735000000000

# 4. Tail the most recent run in plain mode (good for CI / asciinema).
node packages/tui/bin/tui.mjs watch --plain
```

For the interactive Ink-rendered watch UI (slice 5):

```sh
cd packages/tui
npm install                     # pulls Ink + React + Yoga + Commander.
node bin/tui.mjs watch          # auto-detects TTY; renders the live UI.
```

## Plain-mode log line format

Every event renders as a single space-separated line. The columns are
stable so `grep`, `awk`, and friends work directly:

```text
HH:MM:SS.mmm  <verb>  <runId>  iter=N/M  tokens=I/O  excerpt="…"
```

| Field        | When present                                        |
| ------------ | --------------------------------------------------- |
| `HH:MM:SS.mmm` | Always — UTC, ms precision (CI-stable).           |
| `<verb>`     | One of `armed`, `iter+`, `iter-`, `pause`, `resume`, `stagn`, `done `, `abort`. |
| `<runId>`    | Always.                                             |
| `iter=N/M`   | When the event has an iteration counter.            |
| `min=N`      | Only on `armed`.                                    |
| `tokens=I/O` | On `iteration_end` when usage was observed.         |
| `streak=N`   | On `stagnation` events.                             |
| `reason=…`   | On `complete` / `abort`.                            |
| `note="…"`   | On `complete` / `abort` when the loop attached a note. |
| `excerpt="…"` | On `iteration_end` — capped at 80 chars, whitespace collapsed. |

## asciinema recipe

```sh
# Record a 60-second demo of a self-improve loop.
asciinema rec demo.cast \
  --command 'node packages/tui/bin/tui.mjs watch --plain' \
  --idle-time-limit 1.0 \
  --rows 24 --cols 100 \
  --title 'ralph self_improve — live'
```

Tips:

* Pass `--plain` so the recording is plain text and replays cleanly
  on any asciinema player without ANSI quirks.
* Pin `--rows`/`--cols` so the embedded player matches your asset
  dimensions in docs.
* `--idle-time-limit 1.0` collapses long idle gaps between
  iterations so the demo stays watchable end-to-end.

## Override the runs root

```sh
export RALPH_EVENTS_DIR=/tmp/ralph-runs
node packages/tui/bin/tui.mjs list
```

Useful for:

* Testing the TUI against a sandboxed dir without touching real runs.
* CI jobs that want to assert on a specific run without depending on
  the user's home directory.
* Replaying a captured `events.jsonl` from a teammate (drop their
  file at `$RALPH_EVENTS_DIR/<runId>/events.jsonl`).

## Architecture notes

* `src/events.mjs` — pure event contract: `EVENT_TYPES`, `makeRunId`,
  `serializeEvent`, `parseEventLine`, `foldEvents`. Stdlib-only so
  the loop handler can import it directly.
* `src/writer.mjs` — DI'd JSONL writer used by the loop handler.
  Maintains `<root>/index.jsonl` so `list` enumerates runs without
  recursing into every per-run dir.
* `src/tail.mjs` — `readEventsFile` (sync, for `replay`) and
  `tailEventsFile` (async iterator, for `watch`). Polls and detects
  file replacement by tracking **both** `ino` and `birthtimeMs`,
  so a `replay`-style overwrite (or any unlink+create that happens
  to reuse the freed inode — common on Linux ext4) still restarts
  the reader at offset 0.
* `src/plain.mjs` — `formatEventLine`: pure event → log line. The
  Ink renderer (slice 5) shares this module for non-TTY fallback.
* `bin/tui.mjs` — argv parser + dispatcher. Stdlib-only today; will
  promote to Commander once the Ink renderer's deps land.

## Tests

```sh
# From the repo root.
npm test

# Or scoped to the TUI package.
node --test packages/tui/test/*.test.mjs
```

Coverage for the non-render layer:

* `events.test.mjs` — serializer / parser invariants, `foldEvents`
  fold behavior across every event type.
* `writer.test.mjs` — DI-driven writer behavior, index file shape,
  error surfacing through `onError`.
* `tail.test.mjs` — partial-line buffering, malformed-line tolerance,
  ENOENT-until-it-exists, and file-replacement detection along **both**
  axes the implementation tracks: a fresh inode (ino change) and a
  reused inode whose `birthtimeMs` advanced (the Linux-ext4 blind
  spot a naïve ino-only check would miss).
* `plain.test.mjs` — every event type's expected log-line shape,
  excerpt truncation/collapse, garbage-input safety.
* `bin.test.mjs` — argv parser, `--help`, `list` (empty + populated),
  `replay` (success + missing-runId), unknown-command exit code.

## Stack reference

See [`docs/cli-stack.md`](../../docs/cli-stack.md) for the full
Ink + Yoga + Commander stack-verification, including precedent in
Anthropic's Claude Code CLI and GitHub Copilot CLI.
