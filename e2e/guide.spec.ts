import { expect, test } from '@playwright/test';

/**
 * The guide homepage is the frontend's whole product: index.html fetches
 * /GUIDE.md, renders it with the image-vendored marked.js + highlight.js,
 * and builds the auto-TOC from the rendered headings. This spec pins the
 * wiring facts no build check can see: the baked-in markdown is served,
 * the vendored renderer actually runs (no CDN, no console errors), and
 * the load stub is replaced by real content.
 */
test('the guide homepage renders from the baked-in GUIDE.md', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    // The bare nginx image ships no favicon; that one 404 is cosmetic and
    // unavoidable without touching the teaching files — everything else on
    // the console is a wiring signal.
    const url = msg.location().url;
    if (msg.type() === 'error' && !url.includes('favicon')) {
      consoleErrors.push(`${msg.text()} (${url})`);
    }
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  await page.goto('/');

  // Rendered markdown replaces the "Loading GUIDE.md …" stub, and the
  // guide's own h1 arrives with it.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    /Kubernetes A–Z/,
  );
  await expect(page.locator('#load-state')).toHaveCount(0);

  // The auto-TOC fills from the guide's own headings (the shipped guide
  // has ~20 h1/h2/h3s across ten sections).
  const tocLinks = page.locator('#toc-list a');
  const tocCount = await tocLinks.count();
  expect(tocCount).toBeGreaterThan(10);
  await expect(tocLinks.filter({ hasText: 'What this lab is' })).toHaveCount(
    1,
  );

  // The topbar's dashboard link is part of the page contract.
  await expect(page.getByRole('link', { name: /Try the app/ })).toBeVisible();

  // The vendored renderer must do its job without a single console error.
  expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
});
