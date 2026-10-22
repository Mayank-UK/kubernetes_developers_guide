const express = require('express');
const https = require('https');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 9000;

const FACTS_BASE = process.env.FACTS_URL || 'http://facts:8000';
const LOAD_TARGET = `${FACTS_BASE}/facts?topic=load-test&spin=true`;

// Run state (module scope). Counters reset at each /load/start.
const state = {
  running: false,
  startedAt: null,
  durationSec: null,
  concurrency: null,
  requestsSent: 0,
  errors: 0,
  inFlight: 0,
  targetUrl: null,
};

// ---- simulated HPA ------------------------------------------------------------
// Outside Kubernetes (the docker compose deployments) there is no real HPA —
// the k8s lab runs that one (§7). What the compose stacks CAN do honestly is
// simulate one from the request rate this generator itself produces, so the
// dashboard's live diagram can show replicas rising and falling with load.
// Same shape as a real HPA: utilization signal (smoothed rps), scale-up and
// scale-down thresholds with a hysteresis gap between them, min/max bounds,
// and a cooldown so it never flaps.
const HPA = {
  MIN: 1,
  MAX: 6, // mirrors the lab's 40-hpa.yaml bounds
  UP_RPS: 30, // scale up above 30 requests/sec (smoothed)
  DN_RPS: 15, // scale back down below 15 (hysteresis gap: 15..30 is neutral)
  PERIOD_MS: 1000, // sampling tick
  COOLDOWN_MS: 5000, // minimum spacing between any two scaling decisions
};

const hpa = {
  replicas: HPA.MIN,
  ewma: null, // smoothed requests/sec; null until the first sample pair
  lastSample: null, // requestsSent at the previous tick
  lastScaleAt: 0, // epoch ms of the last scaling decision
  events: [], // {at, seq, text} — newest last, capped
  seq: 0,
};

function hpaEvent(text) {
  hpa.seq += 1;
  hpa.events.push({ at: new Date().toISOString(), seq: hpa.seq, text });
  if (hpa.events.length > 20) hpa.events.splice(0, hpa.events.length - 20);
}

function hpaActive() {
  return state.running || hpa.replicas > HPA.MIN;
}

function resetHpa(runLabel) {
  hpa.replicas = HPA.MIN;
  hpa.ewma = null;
  hpa.lastSample = null;
  hpa.lastScaleAt = 0;
  hpaEvent(runLabel);
}

// The sampling loop: one tick per second computes the raw request rate from
// the requestsSent delta, smooths it (EWMA, alpha 0.3), and applies the
// thresholds. While no run is active it keeps draining replicas back to MIN
// so the scale-down is visible after a run ends.
setInterval(() => {
  const sent = state.requestsSent;
  let raw = 0;
  if (hpa.lastSample != null) raw = Math.max(0, sent - hpa.lastSample);
  hpa.lastSample = sent;
  hpa.ewma = hpa.ewma == null ? raw : 0.3 * raw + 0.7 * hpa.ewma;

  if (!hpaActive()) return;
  const now = Date.now();
  if (now - hpa.lastScaleAt < HPA.COOLDOWN_MS) return;
  const rate = Math.round(hpa.ewma);

  if (hpa.ewma > HPA.UP_RPS && hpa.replicas < HPA.MAX) {
    hpa.replicas += 1;
    hpa.lastScaleAt = now;
    hpaEvent(`replica facts-${hpa.replicas} added (rate ${rate} rps > ${HPA.UP_RPS})`);
  } else if (hpa.ewma < HPA.DN_RPS && hpa.replicas > HPA.MIN) {
    hpaEvent(`replica facts-${hpa.replicas} removed (rate ${rate} rps < ${HPA.DN_RPS})`);
    hpa.replicas -= 1;
    hpa.lastScaleAt = now;
  }
}, HPA.PERIOD_MS);
// ------------------------------------------------------------------------------

// Aborted alongside its run: in-flight fetches reject immediately on stop.
let currentRun = null;

app.use(express.json());

// Log every request to stdout: method, path, status.
app.use((req, res, next) => {
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode}`);
  });
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ---- load engine -------------------------------------------------------------

// One worker keeps ONE request in flight until the deadline passes or the run
// is aborted. Any HTTP response counts as a request sent (status ignored);
// transport failures and HTTP error statuses are counted in `errors` instead.
async function worker(deadline, signal) {
  while (!signal.aborted && Date.now() < deadline) {
    state.inFlight += 1;
    try {
      const res = await fetch(state.targetUrl, { signal });
      await res.arrayBuffer().catch(() => {}); // drain so the socket is reusable
      state.requestsSent++;
      if (!res.ok) state.errors++;
    } catch (err) {
      if (err && err.name === 'AbortError') break; // run cancelled
      state.errors++;
    } finally {
      state.inFlight -= 1;
    }
  }
}

async function runLoad(durationSec, concurrency, signal) {
  const deadline = Date.now() + durationSec * 1000;
  const workers = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker(deadline, signal));
  await Promise.all(workers);
  state.running = false; // natural finish and stop both land here
}

function validateParams(body) {
  const b = body || {};
  let durationSec = 60;
  let concurrency = 10;

  if (b.durationSec !== undefined) {
    if (typeof b.durationSec !== 'number' || !Number.isFinite(b.durationSec)) {
      return { error: 'durationSec must be a number' };
    }
    durationSec = Math.min(300, Math.max(10, b.durationSec));
  }
  if (b.concurrency !== undefined) {
    if (typeof b.concurrency !== 'number' || !Number.isFinite(b.concurrency)) {
      return { error: 'concurrency must be a number' };
    }
    concurrency = Math.min(50, Math.max(1, b.concurrency));
  }
  return { durationSec, concurrency };
}

// ------------------------------------------------------------------------------

app.post('/load/start', (req, res) => {
  if (state.running) {
    return res.status(409).json({ ok: false, error: 'already running' });
  }
  const { durationSec, concurrency, error } = validateParams(req.body);
  if (error) {
    return res.status(400).json({ ok: false, error });
  }

  const controller = new AbortController();
  currentRun = controller;

  state.running = true;
  state.startedAt = new Date().toISOString();
  state.durationSec = durationSec;
  state.concurrency = concurrency;
  state.requestsSent = 0;
  state.errors = 0;
  state.inFlight = 0;
  state.targetUrl = LOAD_TARGET;
  resetHpa(`load run started (${durationSec}s x ${concurrency} workers)`);

  runLoad(durationSec, concurrency, controller.signal).catch((err) => {
    console.error('load run crashed:', err);
    state.running = false;
  });

  res.json({ ok: true, running: true, durationSec, concurrency });
});

app.post('/load/stop', (req, res) => {
  if (currentRun) currentRun.abort();
  state.running = false;
  state.inFlight = 0; // aborted fetches reject immediately; nothing survives
  res.json({ ok: true, running: false });
});

app.get('/load/status', (req, res) => {
  res.json({
    running: state.running,
    startedAt: state.startedAt,
    durationSec: state.durationSec,
    concurrency: state.concurrency,
    requestsSent: state.requestsSent,
    errors: state.errors,
    inFlight: state.inFlight,
    rateRps: hpa.ewma == null ? 0 : Math.round(hpa.ewma * 10) / 10,
    targetUrl: state.targetUrl,
  });
});

// ---- kubernetes api (core https only) ----------------------------------------

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

function k8sGet(host, port, path, token, ca) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { host, port, path, ca, headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`kubernetes api returned ${res.statusCode}`));
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error('kubernetes api returned invalid json'));
          }
        });
      }
    );
    req.on('error', reject);
  });
}

app.get('/load/replicas', async (req, res) => {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT;
  if (!host || !port) {
    // Not in a cluster: while a load run is active (or draining back down)
    // report the simulated HPA so the dashboard's live diagram can show
    // replicas rising and falling with the rate. Settled and idle, the old
    // graceful shape stands.
    if (hpaActive()) {
      return res.json({
        mode: 'simulated-hpa',
        replicas: hpa.replicas,
        rateRps: hpa.ewma == null ? 0 : Math.round(hpa.ewma * 10) / 10,
        minReplicas: HPA.MIN,
        maxReplicas: HPA.MAX,
        scaleUpRps: HPA.UP_RPS,
        scaleDownRps: HPA.DN_RPS,
        reason:
          'the deployed stack is docker compose; the k8s lab runs the real HPA',
        events: hpa.events.slice(-12),
      });
    }
    return res.json({ replicas: null, error: 'not in kubernetes' });
  }
  try {
    const token = fs.readFileSync(`${SA_DIR}/token`, 'utf8');
    const ca = fs.readFileSync(`${SA_DIR}/ca.crt`);
    const ns = process.env.POD_NAMESPACE || 'k8slab';
    const dep = await k8sGet(
      host,
      port,
      `/apis/apps/v1/namespaces/${ns}/deployments/facts`,
      token,
      ca
    );
    res.json({
      replicas: dep.spec && dep.spec.replicas != null ? dep.spec.replicas : null,
      readyReplicas: dep.status && dep.status.readyReplicas != null ? dep.status.readyReplicas : null,
    });
  } catch (err) {
    res.json({ replicas: null, error: String((err && err.message) || err) });
  }
});

// JSON parse failures and anything else → 400/500 JSON, never a crash.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'invalid JSON body' });
  }
  res.status(500).json({ ok: false, error: 'internal error' });
});

app.listen(PORT, () => {
  console.log(`loadgen listening on port ${PORT}`);
});
