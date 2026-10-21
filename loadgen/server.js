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
  targetUrl: null,
};

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
    try {
      const res = await fetch(state.targetUrl, { signal });
      await res.arrayBuffer().catch(() => {}); // drain so the socket is reusable
      state.requestsSent++;
      if (!res.ok) state.errors++;
    } catch (err) {
      if (err && err.name === 'AbortError') break; // run cancelled
      state.errors++;
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
  state.targetUrl = LOAD_TARGET;

  runLoad(durationSec, concurrency, controller.signal).catch((err) => {
    console.error('load run crashed:', err);
    state.running = false;
  });

  res.json({ ok: true, running: true, durationSec, concurrency });
});

app.post('/load/stop', (req, res) => {
  if (currentRun) currentRun.abort();
  state.running = false;
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
