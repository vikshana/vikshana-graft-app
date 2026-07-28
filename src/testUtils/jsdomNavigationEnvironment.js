'use strict';

/**
 * Custom Jest test environment used for tests that need to assert on real
 * (non-hash) browser navigation triggered by application code, e.g.
 * `window.location.href = '/some/path'`.
 *
 * Why this exists:
 * jsdom (v21+) intentionally makes `window.location` and its properties
 * "unforgeable" own properties to match real browser spec behaviour. That
 * means `window.location` can never be replaced, deleted, or redefined from
 * test code (`delete window.location`, `window.location = {...}`, and
 * `Object.defineProperty(window, 'location', ...)` are all no-ops or throw
 * `TypeError: Cannot redefine property`). Setting `window.location.href` to
 * a different path always funnels through jsdom's internal, real
 * `navigate()` implementation - which is a stub that emits a
 * "Not implemented: navigation" jsdomError and never actually mutates
 * `window.location`. As a result, `window.location.href` can never be
 * observed to change for a full path/query navigation in jsdom, no matter
 * what a test does.
 *
 * This environment works around that the only way jsdom actually allows:
 * by patching jsdom's own internal `navigate()` function (the single choke
 * point every `Location` mutation funnels through) from within the same
 * Node `require()` realm jsdom itself uses internally - something that is
 * NOT reachable via `jest.mock()` from a test file, since jsdom's `window`
 * is constructed by the test *environment* using a separate, unsandboxed
 * require realm from the one Jest sets up for test files under test.
 *
 * Tests can read `window.__navigationAttempts__` (an array of the fully
 * resolved URL strings every navigation attempt was made with) instead of
 * needing to touch `window.location` at all. The patch delegates to the
 * real implementation, so normal jsdom behaviour (including the
 * "Not implemented: navigation" jsdomError log) is unaffected - this is
 * purely an additive recording hook, safe to use alongside any other test
 * in the same file.
 */

const whatwgURL = require('whatwg-url');
const navigationModule = require('jsdom/lib/jsdom/living/window/navigation.js');

// Guard against double-patching if this environment is instantiated more
// than once within the same worker process (e.g. multiple test files using
// it in the same run).
if (!navigationModule.__graftNavigationPatched__) {
  const originalNavigate = navigationModule.navigate;

  navigationModule.navigate = function patchedNavigate(window, url, flags) {
    if (window && Array.isArray(window.__navigationAttempts__)) {
      window.__navigationAttempts__.push(whatwgURL.serializeURL(url));
    }
    return originalNavigate(window, url, flags);
  };

  navigationModule.__graftNavigationPatched__ = true;
}

const JSDOMEnvironment = require('jest-environment-jsdom').default;

class JSDOMNavigationEnvironment extends JSDOMEnvironment {
  async setup() {
    await super.setup();
    this.global.__navigationAttempts__ = [];
  }
}

module.exports = JSDOMNavigationEnvironment;
