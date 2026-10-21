# AI defined section:

## Current state
- ✅ LAB FULLY PRACTICED END-TO-END 2026-10-11 (P0–P5 all green, AI-driven while user watched; narratives & gotchas → devlog.md 2026-10-11 entry). Build/contracts unchanged since the 2026-10-08 rename.
- Layout: code in `facts/ counter/ image/ frontend/ loadgen/` · Dockerfiles in `.docker/<svc>/` · manifests in `.k8s/` (kind-cluster.yaml + `manifests/` 00–40, numbered, teaching headers carry commands) · images `k8slab/*:v1`.
- Contracts: counter :3000 POST /count · facts :8000 GET /facts?topic[&spin=true] (env COUNTER_URL) · image :8080 GET /image · loadgen :9000 /load/start|stop|status + /load/replicas (SA+RBAC) · nginx frontend proxies /api/{facts,image,load/} — counter is internal by design (no /api/count).
- Guide (2026-10-11): GUIDE.md (800 lines, P0–P5 spine, concept → command → what it proves) baked into the frontend image (marked 12.0.2 + highlight.js 11.11.1 vendored at BUILD time, sha256-pinned, offline). Layout mirrors github_actions per user request: `/` = index.html = the guide, `/app.html` = dashboard. GUIDE.md is IMAGE CONTENT: edit → rebuild (repo-root context) → `kind load` → redeploy. ingress-nginx kind URL fixed (missing `/static/`) and documented in 30-ingress.yaml header + guide §6.
- Session (2026-10-14, dual-cluster stress test with the github_actions lab): ingress host port MOVED 8080→8090 permanently (github_actions' cluster holds 8080 when both run) — kind-cluster.yaml + GUIDE.md + 30-ingress/18-frontend headers renumbered, frontend image REBUILT (guide baked in). Cluster brought up (5/5 deploys, P4/P5 dormant) then TORN DOWN same day (`kind delete cluster --name k8slab`; zero contexts/nodes). Next bring-up: P0 + Images lines — all v1 images incl. rebuilt frontend cached locally.

## Practice runbook (phase commands; details in manifest headers + devlog 2026-10-11)
- P0 ✅ Cluster & nodes — `kind create cluster --config .k8s/kind-cluster.yaml --name k8slab` · `kubectl get nodes -o wide` · `docker ps` (nodes are containers; ~30s NotReady until kindnet CNI starts)
- Images ✅ — `docker build -t k8slab/<svc>:v1 -f .docker/<svc>/Dockerfile <svc-dir>` (likewise counter, image, loadgen) · frontend builds from REPO ROOT (bakes GUIDE.md): `docker build -t k8slab/frontend:v1 -f .docker/frontend/Dockerfile .` · `kind load docker-image k8slab/facts:v1 k8slab/counter:v1 k8slab/image:v1 k8slab/loadgen:v1 k8slab/frontend:v1 --name k8slab`
- P1 ✅ Pods — `kubectl apply -f .k8s/manifests/00-namespace.yaml -f .k8s/manifests/01-facts-pod.yaml` · get/describe/logs/exec · `kubectl -n k8slab port-forward pod/facts-raw 8000:8000` · delete → stays gone · end: `kubectl delete -f .k8s/manifests/01-facts-pod.yaml`
- P2 ✅ Deployments & Services — `kubectl apply -f .k8s/manifests/` (30/40 dormant till P4/P5; 01 reapplies — delete again) · `kubectl -n k8slab port-forward svc/frontend 8081:80` (8081 avoids both ingress ports: k8slab's 8090 mapping + the github_actions lab's 8080) · `kubectl -n k8slab delete pod -l app.kubernetes.io/name=facts` → self-heal · `kubectl -n k8slab scale deploy/facts --replicas=3` → load balance in logs (random per-connection)
- P3 ✅ Config & health — inspect 05-configmap / 06-secret · `kubectl -n k8slab exec deploy/facts -- env | grep COUNTER` · `kubectl -n k8slab delete configmap k8slab-config` → replacements stuck (CreateContainerConfigError) → re-apply → kubelet self-recovers · `kubectl -n k8slab exec deploy/counter -- kill 1` → RESTARTS+1, container restarts in place
- P4 ✅ Ingress — apply ingress-nginx (kind provider URL + **nodeSelector patch** in 30-ingress.yaml header — upstream main no longer pins ingress-ready; a worker-placed controller leaves :8090 dark) · `kubectl apply -f .k8s/manifests/30-ingress.yaml` · open http://localhost:8090
- P5 ✅ Autoscaling — metrics-server install + patch (commands in 40-hpa.yaml header) · `kubectl -n k8slab get hpa -w` · UI Load card 60s × 20 (observed: idle 3→1; load 1→4→6 @252% CPU; settle 6→4→2→1) · finale: `kubectl -n k8slab rollout history deploy/facts` + `rollout undo`
- Teardown anytime — `kind delete cluster --name k8slab`

# Developer defined section:

- Project requirements
    - I want practice Kubernetes fundamentals, how nodes, pods, containers, etc are created, how they communicate with each, in this project there will be basic microservices communicating with each, I want everything included like autoscaling, load balancing, etc. I am new to kubernetes so I don't know much what it offers
    - You will write yaml files for all this setup and I will practice via command line

- Generic instructions:
    - Follow the most standard approach in industry, I don't want custom hack and slash solutions
    - Update the status markers: ✅ done · 🚧 in progress · ⏳ pending for the tasks

- Development tasks:
    - First write the plan here what you are going to do, then I will approve ✅ (plan v2 approved → built → end-to-end verified; then practiced live P0–P5 on 2026-10-11)
    - Add a single `GUIDE.md` teaching this lab's Kubernetes fundamentals A–Z from its own files (concept → command → what it proves; snippets sourced from `.k8s/` manifests + service code + Dockerfiles; cover the runbook phases P0–P5 as the spine), served by the frontend like the github_actions lab (markdown renderer baked into the image, offline). Keep it SIMPLE — a Kubernetes lab guide, not a ci/cd-scale volume. Two-file rule: only agentic_development.md + GUIDE.md ⏳ → ✅ done 2026-10-11 (GUIDE.md stayed the single content file; serving required wiring edits to frontend Dockerfile/nginx.conf/index.html — see Current state "Guide" line and devlog)
