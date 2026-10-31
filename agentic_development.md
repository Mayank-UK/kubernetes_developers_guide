# AI defined section:

## Current state
- K8s lab FULLY PRACTICED end-to-end 2026-10-11 (P0–P5 green; narratives & gotchas → devlog 2026-10-11). Build/contracts unchanged since the 2026-10-08 rename.
- Layout: code in `facts/ counter/ image/ frontend/ loadgen/` · Dockerfiles in `.docker/<svc>/` · manifests in `.k8s/` (kind-cluster.yaml + `manifests/` 00–40, numbered; teaching headers carry
  the commands) · images `k8slab/*:v1`.
- Contracts: counter :3000 POST /count · facts :8000 GET /facts?topic[&spin=true] (env COUNTER_URL) · image :8080 GET /image · loadgen :9000 /load/start|stop|status + /load/replicas (SA+RBAC) ·
  nginx frontend proxies /api/{facts,image,load/} — counter is internal by design (no /api/count).
- GUIDE.md (2026-10-24 REWRITTEN as a generic course per user request, 811 → 2,909 lines, pushed 2c9f13c; old lab-only P0–P5 walkthrough superseded): Part I = 31-chapter GENERIC K8s course
  (Concept → "On the cluster:" → Code; 33 `<!-- source: -->` quotes from lab manifests, 42 `<!-- concept -->` generic examples) + Part II = the lab (services, manifests 00–40, P0–P5 runbook, 9
  gotchas).
  Rendering unchanged: marked 12.0.2 + highlight.js 11.11.1 vendored, baked into the frontend image (offline); `/` = guide, `/app.html` = dashboard. GUIDE.md is IMAGE CONTENT: edit → rebuild
  (repo-ROOT context) → `kind load` → redeploy. frontend:v1 was rebuilt 2026-10-24 with the new guide; standalone preview closed (8090 free for the kind ingress). CI rebuilds GHCR images on push;
  production deploy stays manual.
- Ports: kind ingress host port = 8090 PERMANENTLY (moved from 8080 on 2026-10-14 — github_actions' cluster holds 8080 when both run; kind-cluster.yaml + GUIDE.md + 30-ingress/18-frontend headers
  renumbered). P2 port-forward uses 8081 (avoids both ingress ports). Cluster last up 2026-10-14, torn down same day (`kind delete cluster --name k8slab`); next bring-up = P0 + Images lines below
  — all v1 images incl. rebuilt frontend cached locally.
- Domain: mayankcodeworks.com since 2026-10-23 (old makbuilds.duckdns.org URLs 301 at the caddy edge).
- CI/CD (family "multi-service static" variant; site LIVE, lab teaching files untouched): `.github/workflows/ci.yml` = test → secrets → e2e → vm-arch → build-push 5-matrix → ghcr-prune.
  `deploy-production.yml` = blue/green `kdg_blue`/`kdg_green`; flip = write `platform/upstream.caddy` `reverse_proxy kdg_frontend_<color>:80` + `docker exec caddy caddy reload`.
  Stack: `.docker/docker-compose-prod.yml` — FIVE services (frontend + counter + facts + image + loadgen; loadgen added 2026-10-22 for the dashboard Load Simulator — /load/replicas degrades
  gracefully outside k8s; old frontend `loadgen` alias hack REMOVED), app_internal per color + external kdg_frontend. Plus `docker-compose.ci.yml` (project kubernetes_developers_guide_ci,
  127.0.0.1:8080, all five pinned :ci) + committed `.docker/.env` (IMAGE_TAG=ci). Images `ghcr.io/mayank-uk/kubernetes-guide-{frontend,counter,facts,image,loadgen}`; e2e probes /api/load/status
  through nginx.
- Umami analytics (live, 2026-10-24; commits c6b2dc1 + 9a4f48d stale-e2e-spec fix riding the concurrent GUIDE.md rewrite 2c9f13c): website_id ae541904-7c43-4a02-9c0c-4f941bc6dbb5. Static wiring:
  `frontend/js/analytics.js` carrier + `__UMAMI_*__` token beacon in the HTML; the Dockerfile swaps the tokens when BOTH UMAMI_* repo-level GitHub Variables are set (NEVER environment-scoped) and
  DELETES the beacon line otherwise (an empty src re-fetches the page as a script). Events: topic-open{topic} (TOC clicks) · external-link{target}. Verify = runtime DOM check + umami postgres
  (static greps are false negatives).
- Umami data-distinct-id (2026-10-25): inline pre-beacon snippet in frontend/index.html + app.html stamps a localStorage UUID (mcw_vid) onto the beacon tag → Umami
  identify() dedupes visitors across IP churn; self-guards (SCRIPT tagName + data-website-id) so it inert-no-ops in builds that delete the __UMAMI_SRC__ line.
  Verified by Dockerfile sed swap/delete simulation + node guard sim (/tmp/verify-kdg/verify.log); runtime check pending post-deploy.
- Live diagram (2026-10-22, `/app.html` "Live service graph" — replaced the failed static corner topology): plain SVG+rAF, no libs; truthful edges (browser→nginx, loadgen→facts
  DIRECT bypassing nginx, nginx→facts/image, facts→counter+Wikipedia, image→Commons); particles whose density/speed track `rateRps`; per-run counters (sent/in-flight/replies/errors/rate); event
  ticker.
  loadgen simulated-HPA state machine (compose has no autoscaler): 1s tick, EWMA α=0.3 on measured rps, +1 replica >30 rps, −1 <15 (hysteresis), cooldown 5s, bounds 1–6 (mirrors 40-hpa.yaml).
  `/load/status` += inFlight/rateRps; `/load/replicas` answers {mode:"simulated-hpa", replicas, rateRps, reason, events[]} while a run is active OR draining, old {replicas:null,error:"not in
  kubernetes"} when settled idle; real k8s read unchanged when SA env present (GUIDE §7.2 quotes stay true).
  Local CI-stack verification: sibling github_actions dev stack holds 127.0.0.1:8080 — verify against a /tmp port override (e.g. 8180) + `E2E_BASE_URL`; repo compose untouched.
- Practice runbook (phase commands; details in manifest headers + devlog 2026-10-11):
  - P0 Cluster — `kind create cluster --config .k8s/kind-cluster.yaml --name k8slab` · `kubectl get nodes -o wide` · `docker ps` (nodes are containers; ~30s NotReady until kindnet CNI starts).
- Images — per-svc `docker build -t k8slab/<svc>:v1 -f .docker/<svc>/Dockerfile <svc-dir>`; frontend from REPO ROOT (bakes GUIDE.md): `docker build -t k8slab/frontend:v1 -f
  .docker/frontend/Dockerfile .` · `kind load docker-image k8slab/facts:v1 k8slab/counter:v1 k8slab/image:v1 k8slab/loadgen:v1 k8slab/frontend:v1 --name k8slab`.
- P1 Pods — `kubectl apply -f .k8s/manifests/00-namespace.yaml -f .k8s/manifests/01-facts-pod.yaml` · get/describe/logs/exec · `kubectl -n k8slab port-forward pod/facts-raw 8000:8000` · delete
  raw pod stays gone · end: `kubectl delete -f .k8s/manifests/01-facts-pod.yaml`.
- P2 Deployments & Services — `kubectl apply -f .k8s/manifests/` (30/40 dormant till P4/P5; 01 reapplies — delete again) · `kubectl -n k8slab port-forward svc/frontend 8081:80` · `kubectl -n
  k8slab delete pod -l app.kubernetes.io/name=facts` → self-heal · `kubectl -n k8slab scale deploy/facts --replicas=3` → load balance in logs (random per-connection).
- P3 Config & health — inspect 05-configmap/06-secret · `kubectl -n k8slab exec deploy/facts -- env | grep COUNTER` · delete configmap → CreateContainerConfigError → re-apply → kubelet
  self-recovers · `kubectl -n k8slab exec deploy/counter -- kill 1` → RESTARTS+1, restarts in place.
- P4 Ingress — apply ingress-nginx (kind provider URL + nodeSelector patch in 30-ingress.yaml header — upstream main no longer pins ingress-ready; a worker-placed controller leaves :8090 dark) ·
  `kubectl apply -f .k8s/manifests/30-ingress.yaml` · open http://localhost:8090.
- P5 Autoscaling — metrics-server install + patch (commands in 40-hpa.yaml header) · `kubectl -n k8slab get hpa -w` · UI Load card 60s × 20 · finale: `kubectl -n k8slab rollout history
  deploy/facts` + `rollout undo`.
  - Teardown anytime — `kind delete cluster --name k8slab`.

## Active tasks
- Faro crash-telemetry beacon ✅ 2026-10-31 (commit 5d68b2b): static token-swap carrier (umami-mirrored) — frontend/js/faro.js loader + __FARO_URL__/__FARO_APP__ tokens, Dockerfile sed swap w/ beacon-free negative case, ci build-args. Docker-build pos/neg verified. Needs repo Variables FARO_URL + FARO_APP=kubernetesdevelopersguide.
- ⏳ Update Logs page (`/updates` beside `/` and `/app.html`, linked from the guide's top bar), seeded with the 2026-10-24 "GUIDE.md rewritten as generic course" entry — task spec + the
  Update-Logs convention live in the Developer section below.

# Developer defined section:

- Project requirements
    - I want practice Kubernetes fundamentals, how nodes, pods, containers, etc are created, how they communicate with each, in this project there will be basic microservices communicating with each, I want everything included like autoscaling, load balancing, etc. I am new to kubernetes so I don't know much what it offers
    - You will write yaml files for all this setup and I will practice via command line

- Generic instructions:
    - Follow the most standard approach in industry, I don't want custom hack and slash solutions
    - Update the status markers: ✅ done · 🚧 in progress · ⏳ pending for the tasks
    - New MAJOR works — adding a new topic or section to the guide, a new page or feature, anything a reader would notice — must be recorded on the **Update Logs page**: the site's dated, user-facing change log (distinct from devlog.md, which stays internal archive). Small fixes and typos do NOT need an entry. The page doesn't exist yet — create it (e.g. `/updates` alongside `/` and `/app.html`) as part of the first qualifying work, seeded with an entry for that work.

- Development tasks:
    - First write the plan here what you are going to do, then I will approve ✅ (plan v2 approved → built → end-to-end verified; then practiced live P0–P5 on 2026-10-11)
    - Add a single `GUIDE.md` teaching this lab's Kubernetes fundamentals A–Z from its own files (concept → command → what it proves; snippets sourced from `.k8s/` manifests + service code + Dockerfiles; cover the runbook phases P0–P5 as the spine), served by the frontend like the github_actions lab (markdown renderer baked into the image, offline). Keep it SIMPLE — a Kubernetes lab guide, not a ci/cd-scale volume. Two-file rule: only agentic_development.md + GUIDE.md ⏳ → ✅ done 2026-10-11 (GUIDE.md stayed the single content file; serving required wiring edits to frontend Dockerfile/nginx.conf/index.html — see Current state "Guide" line and devlog)
    - Rewrite GUIDE.md as GENERIC Kubernetes learning material (not lab-only), modeled on github_actions_developers_guide's GUIDE.md (Part I generic course + Part II lab) ✅ 2026-10-24 — 2,909 lines; mechanical checks green (/tmp/verify-k8s-guide.log: fences, 33 source paths, chapters 1–31 sequential, quotes verbatim); frontend image rebuilt, preview served then closed, pushed (2c9f13c) same day.
    - CI/CD pipeline (family static variant) ✅ 2026-10-22 (see Current state CI/CD line). Follow-ups ⏳: create the GitHub repo (URL exists, repo doesn't), push master, add `production` environment secrets (VM_HOST/USER/PRIVATE_KEY/FINGERPRINT, GHCR_USER/GHCR_PULL_TOKEN), add the `kdg` caddy snippet on the VM, then first deploy (targets blue).
    - Create the Update Logs page on the site (e.g. `/updates` beside `/` and `/app.html`, linked from the guide's top bar), seed it with the 2026-10-24 "GUIDE.md rewritten as generic course" entry; every new major work gets a dated entry there from then on ⏳
- Ops 2026-10-25: frontend image now COPYs favicon.ico (Umami needs /favicon.ico at root); deployed via green CI at 3dd8c58.
- Ops 2026-10-29: favicon.ico regenerated via librsvg (qlmanage render was blank white). Deployed with CI at 316149a.
