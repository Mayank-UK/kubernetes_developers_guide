/* Grafana Faro crash-telemetry loader (vanilla JS) — the static-site
 * mirror of the react guide's crash-telemetry module. The beacon is a
 * plain <script defer> tag in each page's <head> whose
 * data-faro-collector/data-faro-app placeholder tokens are swapped at
 * image build time by .docker/frontend/Dockerfile; the SDK itself is the
 * official CDN IIFE bundle pinned to major @1 (jsdelivr, same philosophy
 * as the vendored renderer — pinned major, no npm dependency). This file
 * is loaded BEFORE the beacon tag on purpose: defer scripts run in
 * document order, so the load listener is attached before the SDK
 * evaluates. Builds without the FARO_* build args (local preview, the
 * lab images) ship NO beacon tag at all — this loader then no-ops, and
 * initializeFaro's defaults capture uncaught errors with the minimal
 * config (url + app only; no transports, no tracing). Idempotent per
 * document: a duplicate beacon load event or a stray second init call
 * can never initialize twice. */
(function () {
  'use strict';

  var beacon = document.querySelector('script[data-faro-app]');
  /* Unconfigured = no beacon tag in the page, or one whose tokens did not
   * survive the build swap (empty string counts as unset). */
  var enabled = !!(beacon
    && beacon.getAttribute('data-faro-collector')
    && beacon.getAttribute('data-faro-app'));

  function initialize() {
    if (!enabled || window.__faroInitialized) return;
    var sdk = window.GrafanaFaroWebSdk;
    if (!sdk || typeof sdk.initializeFaro !== 'function') return;
    window.__faroInitialized = true;
    try {
      sdk.initializeFaro({
        url: beacon.getAttribute('data-faro-collector'),
        app: {
          name: beacon.getAttribute('data-faro-app'),
          environment: 'production'
        }
      });
    } catch (e) { /* telemetry must never break the page */ }
  }

  if (!beacon) return;
  /* Normal path: initialize once the bundle evaluated. A failed/blocked
   * load simply never initializes. Covers the race where the SDK global
   * already exists (listener attached after evaluation) via initialize(). */
  beacon.addEventListener('load', initialize, { once: true });
  initialize();
})();
