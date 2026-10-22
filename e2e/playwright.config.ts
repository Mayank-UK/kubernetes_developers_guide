import { defineConfig, devices } from '@playwright/test';

/**
 * Browser E2E for the k8s lab's served guide — run against a booted
 * frontend container (there is no dev server: the guide page, GUIDE.md,
 * and the vendored renderer are all baked into the image at build time).
 *
 * No `webServer` block on purpose: the stack already runs under Docker
 * Compose. If it is down, boot it from the repo root (requires the four
 * :ci images and the external network):
 *   docker network create kdg_frontend 2>/dev/null || true
 *   docker compose -f .docker/docker-compose-prod.yml \
 *     -f .docker/docker-compose.ci.yml up -d --wait
 */
export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Deterministic by design: a red e2e test is a wiring signal, and
  // re-rolling it throws the information away. Zero retries, one worker —
  // the specs share a single stack.
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: 'line',
  use: {
    // CI points this at the booted prod-image stack (nginx on 127.0.0.1:8080);
    // that loopback publish is the suite's default too.
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080',
    headless: true,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
