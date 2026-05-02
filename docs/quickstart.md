# Quickstart

!!! note "Stub page (issue #2)"
    Scaffold only — to be expanded in follow-ups.

## Install

```bash
git clone https://github.com/kloba/autopilot
cd copilot-ralph-extension
node packages/tui/bin/tui.mjs --help
```

For the interactive Ink-rendered watch UI:

```bash
cd packages/tui && npm install
```

## Drive a loop

```bash
# Drain the existing backlog (red CI → stale PRs → open issues → SDLC).
node packages/tui/bin/tui.mjs run --self-improve --fresh --max 50

# Grow the project backlog with a focus area.
node packages/tui/bin/tui.mjs run --grow-project --fresh --focus "ralph-tui replay UX"

# Custom prompt mode — re-fed verbatim every iter until COMPLETE.
node packages/tui/bin/tui.mjs run \
  --prompt "Refactor packages/tui/src/runner.mjs and add tests. Emit COMPLETE when green." \
  --fresh
```

Stop early:

```bash
node packages/tui/bin/tui.mjs run --stop <runId>
```

See the project [README](https://github.com/kloba/autopilot#readme) for the full reference until these pages are filled in.
