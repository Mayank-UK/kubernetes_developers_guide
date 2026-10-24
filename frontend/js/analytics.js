/* Umami analytics wrapper (vanilla JS) — the static-site mirror of the
 * react guide's analytics module. The beacon is a plain <script defer> tag
 * in each page's <head>, swapped at image build time by
 * .docker/frontend/Dockerfile. Builds without the UMAMI_* build args
 * (local preview, the lab images) ship NO beacon tag at all, so `enabled`
 * below is false and every trackEvent is a silent no-op — call sites need
 * no analytics conditionals of their own. This file is loaded BEFORE the
 * beacon tag on purpose: defer scripts run in document order, so the
 * queue's load/error listeners are attached before the beacon fires them. */
(function () {
  'use strict';

  /* Events emitted before the beacon evaluated (window.umami undefined):
   * queued in order, flushed by the beacon's load event or by the first
   * trackEvent that sees the global; a failed/blocked load DROPS the queue
   * so nothing replays stale. */
  var pending = [];

  /* Unconfigured = no beacon tag in the page, or one whose website id did
   * not survive the build swap (empty string counts as unset). */
  var beacon = document.querySelector('script[data-website-id]');
  var enabled = !!(beacon && beacon.getAttribute('data-website-id'));

  /* Drain the queue in order; it is cleared BEFORE sending so a re-entrant
   * flush can never double-send an entry. try/catch around every track —
   * analytics must never break the interaction that caused the event. */
  function flush() {
    if (!pending.length || !window.umami || typeof window.umami.track !== 'function') return;
    var queued = pending.splice(0, pending.length);
    for (var i = 0; i < queued.length; i++) {
      try { window.umami.track(queued[i][0], queued[i][1]); } catch (e) { /* drop */ }
    }
  }

  if (beacon) {
    beacon.addEventListener('load', flush);
    beacon.addEventListener('error', function () { pending.length = 0; });
  }

  /* The pages' single analytics entry point. Safe to call before this file
   * has run via  (window.trackEvent || function () {})(name, props).
   * Queues while the beacon is loading; never throws. */
  window.trackEvent = function (name, props) {
    if (!enabled) return;
    if (!window.umami || typeof window.umami.track !== 'function') {
      pending.push([name, props || {}]);
      return;
    }
    flush(); /* earlier queued events keep their chronological place */
    try { window.umami.track(name, props || {}); } catch (e) { /* drop */ }
  };
})();
