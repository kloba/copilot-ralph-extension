// Mount the Ink-rendered <App /> against the on-disk state file.
//
// Lazy-imports react/ink so a fresh checkout without `npm install`
// can still run the bin's plain mode (the import will throw
// ERR_MODULE_NOT_FOUND and bin/tui.mjs falls back).

import { defaultStatePath } from "./state.mjs";

/**
 * @param {Object} [args]
 * @param {string} [args.statePath]     Override the state.json path.
 * @param {number} [args.pollMs=500]    Poll interval.
 * @returns {Promise<{ waitUntilExit: () => Promise<void>, unmount: () => void }>}
 */
export async function mountWatcherUi({ statePath = defaultStatePath(), pollMs = 500 } = {}) {
    const [{ render }, React, AppMod] = await Promise.all([
        import("ink"),
        import("react"),
        import("./components/App.mjs"),
    ]);
    const App = AppMod.default ?? AppMod;
    const instance = render(
        React.default.createElement(App, { statePath, pollMs }),
    );
    return {
        unmount: () => { try { instance.unmount(); } catch { /* swallow */ } },
        waitUntilExit: () => instance.waitUntilExit(),
    };
}
