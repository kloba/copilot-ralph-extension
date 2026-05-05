# `@autopilot/tui` — Read-only watcher for the autopilot loop

> Terminal dashboard for the autopilot loop's persisted state file
> (issue #121). Polls `~/.copilot/autopilot/state.json` — written
> atomically by the in-extension loop driver in
> `extension/handler.mjs` — and renders a Header / Timeline / Footer
> dashboard on every poll cycle.

The TUI is **opt-in** and **read-only**. It does not spawn anything,
does not feed prompts, does not drive a loop. The loop itself runs
inside a regular Copilot CLI session — start it with `/autopilot run`.

> **Note:** the legacy out-of-session SDLC driver (`autopilot run …`,
> ~510 LOC of `_legacy-prompts.mjs` / `_legacy-events-emit.mjs` /
> the `runner.mjs` mode-2 path) was removed in 0.7.0. If you used
> the previous mode-2 entry, migrate to `/autopilot run` from a
> regular Copilot CLI session.

## Subcommands

```text
autopilot-tui watch [--plain] [--poll-ms 500] [--state-file PATH]
                                 Mount the live dashboard. Default
                                 command when no subcommand is given.
                                 `--plain` emits a fresh dashboard
                                 block on every poll cycle (auto-on
                                 when stdout is not a TTY).
autopilot-tui show  [--state-file PATH]
                                 Print one dashboard block for the
                                 current state and exit (handy for
                                 scripts).
autopilot-tui where              Print the resolved state-file path.
autopilot-tui --help    | -h     Show usage.
autopilot-tui --version | -V     Print the package version.
```

`q` (or Ctrl-C) quits the TUI. The loop continues running in its
own session — the TUI has no reverse channel.

## Quick start

```sh
# 1. From the repo root, no install needed for plain mode:
node packages/tui/bin/tui.mjs --help

# 2. Print the current state once.
node packages/tui/bin/tui.mjs show

# 3. Watch live (Ink dashboard if `npm install` ran in
#    packages/tui/, otherwise plain text).
node packages/tui/bin/tui.mjs watch
```

## Environment

| Variable                | Default                                    | Description                              |
| ----------------------- | ------------------------------------------ | ---------------------------------------- |
| `AUTOPILOT_STATE_FILE`  | `~/.copilot/autopilot/state.json`          | Override the state-file path. Same effect as `--state-file`. |

## Module layout

* `src/state.mjs` — disk reader + the `RESULT_TOKEN_RE` regex
  (drift-guarded against `extension/handler.mjs` so the TUI and
  loop driver always agree on the token shape).
* `src/format.mjs` — pure-function formatters (durations, clock
  times, outcome rows, header summary). No I/O, fully unit-tested.
* `src/render-plain.mjs` — plain-text dashboard renderer.
* `src/components/{Header,Timeline,Footer,App}.mjs` — Ink
  presentation layer.
* `src/mount.mjs` — lazy-imports `ink` and `react`, mounts the App.
* `bin/tui.mjs` — argv parser + dispatcher. Stdlib-only.

## Running the tests

```sh
node --test packages/tui/test/*.test.mjs
```

(or `npm test` from the repo root, which exercises the extension
tests in the same pass.)
