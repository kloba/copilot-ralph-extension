# Changelog

## Unreleased (heading to 0.3.0)

### Bug fixes
- **Detach during active loop** no longer leaves orphaned `state.active`
  pointing at a torn-down session. Detach now finalizes the loop with
  `reason="detached"` and clears state cleanly so re-attach starts fresh.
- **Silent iterations** (a turn that ends without an `assistant.message`)
  no longer reuse the previous iteration's content for completion / abort /
  stagnation evaluation. The accumulator is reset on each iteration fire-out.
- **Multiple `assistant.message` events per turn** are now accumulated into
  a single content blob instead of overwriting each other, so a completion
  phrase in an earlier message of the turn is no longer lost.
- **Async `session.send` rejections** are caught alongside synchronous
  throws and finish the loop with `reason="send_error"` instead of surfacing
  as an unhandled promise rejection.
- **A throwing `session.log`** can no longer crash event listeners.

### New features
- **`min_iterations` parameter** — forces the loop to run at least N
  iterations before `completion_promise` / `abort_promise` are honored.
  Useful for verification passes. Stagnation still triggers regardless
  (safety override).
- **`ralph_stop` accepts an optional `reason`** string, recorded as
  `note` on the structured result, in the log line, and in the
  `additionalContext` hook injection.
- **Result includes timing** — `startedAt`, `finishedAt`, and `durationMs`
  are now part of the result and the `additionalContext` injection.
- **Prompt length cap** of 64 KiB with a clear error message.

### Tooling
- **install.sh** gained `--help`, `--dry-run`, order-independent argument
  parsing, `node --check` syntax validation of source files before copy,
  and post-copy file existence verification.
- **package.json** enriched with `engines.node`, `keywords`, `bugs`, and
  `homepage` metadata.

### Tests
- Test suite grew from 19 → 41 cases covering the new behaviors and
  regressions for the bugs above.
- Test runner updated to `node --test 'test/**/*.test.mjs'` (no new deps).

## 0.2.0

- Switch ralph_loop to hook/event-driven architecture; tool returns
  immediately and iterations are driven by `assistant.turn_end` plus
  fire-and-forget `session.send`. Eliminates the `sendAndWait` deadlock.

## 0.1.0

- Initial release.
