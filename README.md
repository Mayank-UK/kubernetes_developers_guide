# Kubernetes Developers Guide

A hands-on Kubernetes course (`GUIDE.md`, rendered offline at `/` by the
nginx frontend) plus a live demo stack — `facts` / `counter` / `image` /
`loadgen` teaching services behind an nginx proxy — runnable on kind or
docker compose. CI publishes the five images to GHCR; deploys are
blue/green. Start with `GUIDE.md` and `agentic_development.md`.

## Analytics

The public site is measured with self-hosted
[Umami](https://umami.is) at **https://umami.mayankcodeworks.com**
(cookie-free, no personal data).

- **Build-time swap.** Each page's `<head>` carries the beacon tag with
  `__UMAMI_SRC__` / `__UMAMI_ID__` placeholder tokens;
  `.docker/frontend/Dockerfile` swaps them via the `UMAMI_SRC` /
  `UMAMI_ID` build args. CI passes them from the repository Variables
  `UMAMI_SRC` (beacon URL, e.g. `https://umami.mayankcodeworks.com/script.js`)
  and `UMAMI_ID` (website id). Both values are PUBLIC — they are visible
  in the served page source anyway — so they are Variables, never
  secrets. Local/lab builds without the args ship the pages with no
  beacon tag at all (analytics fully disabled).
- **Events** (`frontend/js/analytics.js`): `topic-open {topic}` — a guide
  TOC section jump or a dashboard topic fan-out; `external-link {target}`
  — an outbound link click in the rendered guide. Pageviews themselves are
  collected by the beacon; events are only real user interactions.

### UTM convention

Links posted off-site carry UTM parameters so referrers are readable in
Umami: `utm_source` = where the link was posted (github, reddit, …),
`utm_medium` = the artifact kind (readme, post, comment).

- https://kubernetesdevelopersguide.mayankcodeworks.com/?utm_source=github&utm_medium=readme
- https://kubernetesdevelopersguide.mayankcodeworks.com/?utm_source=reddit&utm_medium=post
