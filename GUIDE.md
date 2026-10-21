# Kubernetes A–Z — a lab guide taught from this repository's own files

This is the teaching guide for the **k8slab** lab: a kind cluster on your
own Docker, five small services, one practice runbook (phases **P0–P5** in
`agentic_development.md`). Everything here is *demonstrated by files in this
repository* — the YAML is the source of truth, not this prose. The lab also
serves this guide itself: the frontend container ships this file plus a
vendored renderer, so editing `GUIDE.md` changes nothing until that image is
rebuilt ([§8](#8-images--the-build-side)).

Snippets: `<!-- source: path -->` means *copied verbatim from that file*,
sometimes shortened with a `# ...` elision line — open it side-by-side; the
manifest headers carry each phase's exact commands. `<!-- concept -->` means
*illustrative only, not stored in this repo*. Every section: **concept →
command → what it proves**, the proof being something you can *see*. Sections
map 1:1 to the runbook: P0 §2 · P1 §3 · P2 §4 · P3 §5 · P4 §6 · P5 §7.

---

## 1. What this lab is

Five services, each in its own language on purpose (Kubernetes doesn't
care), plus an nginx frontend tying them together:

```
              ┌─────────────────────────────────────────────┐
  browser     │ kind cluster "k8slab" (nodes = containers)  │
  localhost:  │ ingress-nginx ─ / → frontend (nginx :80)    │
  :8090 ─────►│                        │ /api/*             │
              │      ┌────────────┬────┴─────┐              │
              │      ▼            ▼          ▼              │
              │ facts :8000  image :8080  loadgen :9000     │
              │  │ POST /count        │ GET /facts?spin=true│
              │  ▼                   └──────────────────────│
              │ counter :3000                                │
              └──────────────────────────────────────────────┘
```

The contracts (who calls whom):

- **counter** — `POST /count` → word/character/unique-word counts (Node).
- **facts** — `GET /facts?topic=octopus` (optionally `&spin=true`): a
  Wikipedia summary, forwarded to counter (address from the `COUNTER_URL`
  env var) and returned with its counts. FastAPI.
- **image** — `GET /image?topic=octopus`: a Wikimedia Commons picture. Go.
- **loadgen** — `POST /load/start` / `GET /load/status`: fires concurrent
  `?spin=true` requests at facts for the autoscaling demo; backend of the
  dashboard's Load Simulator panel. Node.
- **frontend** — nginx serving the dashboard and proxying `/api/*` to those
  three by their cluster DNS names.

| Path | Owns |
|---|---|
| `facts/ counter/ image/ loadgen/` | service source code (a few files each) |
| `frontend/` | `index.html` (this page), `app.html` (dashboard), `nginx.conf` |
| `.docker/<service>/Dockerfile` | one Dockerfile per service (code dirs stay clean) |
| `.k8s/kind-cluster.yaml` | cluster definition (NOT a k8s resource) |
| `.k8s/manifests/00–40*.yaml` | 17 numbered manifests — one concept each, teaching headers |

---

## 2. P0 · Cluster & nodes

**Concept.** Cloud clusters are slow to build and destroy. **kind**
(Kubernetes-in-Docker) gives you a real control plane — API server,
scheduler, kubelet behavior — where *every node is a plain Docker container*
on your machine: the same binaries production uses, as one control-plane
node + two workers:

<!-- source: .k8s/kind-cluster.yaml -->
```yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
- role: control-plane
  kubeadmConfigPatches:
  - |
    kind: InitConfiguration
    nodeRegistration:
      kubeletExtraArgs:
        node-labels: "ingress-ready=true"
  extraPortMappings:
  - containerPort: 80
    hostPort: 8090
    protocol: TCP
- role: worker
- role: worker
```

Two things pay off later: `extraPortMappings` maps host port **8090 → port
80 inside the control-plane node's container** — the hole the ingress
controller binds in [P4](#6-p4--ingress), and the reason
`http://localhost:8090` will work with no `port-forward` running — 8090
because the github_actions lab's cluster holds the old host port when both
labs run together. And
`node-labels: "ingress-ready=true"` tells the ingress-nginx install which
node to land on. The header also warns: this is a **kind config, not a
Kubernetes resource** — fed to `kind`, never applied.

**Run:**

```console
$ kind create cluster --config .k8s/kind-cluster.yaml --name k8slab
$ kubectl get nodes -o wide
$ docker ps --filter label=io.x-k8s.kind.cluster=k8slab
```

**What it proves.** `kubectl get nodes -o wide` shows three nodes with real
internal IPs; `docker ps` shows the *same three things* as containers — in
kind, a node IS a container. `kind create cluster` also wrote a `kind-k8slab`
context into your kubeconfig and switched to it.

---

## 3. P1 · Pods

**Concept.** A **Pod** is Kubernetes' smallest deployable unit: one or more
containers sharing an IP and lifecycle. You never run "a container" on
Kubernetes — you run a Pod that contains one (all of this lab's hold exactly
one). The lab starts small: one raw Pod running facts, alone, no controller
above it — the whole manifest:

<!-- source: .k8s/manifests/01-facts-pod.yaml -->
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: facts-raw
  namespace: k8slab
  labels:
    app.kubernetes.io/name: facts-raw
    app.kubernetes.io/part-of: k8slab
spec:
  containers:
  - name: facts
    image: k8slab/facts:v1
    imagePullPolicy: IfNotPresent
    ports:
    - name: http
      containerPort: 8000
    env:
    - name: COUNTER_URL
      value: http://counter:3000
```

Every manifest in `.k8s/manifests/` is this shape:

- `apiVersion` / `kind` — *which* API object ("v1 Pod"; Deployments under
  `apps/v1`, HPAs under `autoscaling/v2`). `metadata.name` — its identity;
  with a raw Pod, that's all it has.
- `metadata.labels` — free-form key/value tags. Nothing uses them *yet*, but
  P2's selectors are built on exactly these. Deliberately `facts-raw`, NOT
  `facts`, so the later facts Service can never select this Pod.
- `spec.containers` — image, port, env. `COUNTER_URL` points at a Service
  that *doesn't exist yet*: facts only calls counter per request, so the Pod
  starts fine and counter calls just fail until P2 — no cascade crash.
  `imagePullPolicy: IfNotPresent`: the image is pre-loaded into kind (see
  [§8](#8-images--the-build-side)), so never try a registry pull.

**Declarative vs imperative.** You could create this Pod with a long
`kubectl run` (imperative); instead you `apply` a file (declarative): the
file is the source of truth and `kubectl` reconciles towards it.

**Run** (namespace first — every object in this lab lives in `k8slab`):

```console
$ kubectl apply -f .k8s/manifests/00-namespace.yaml -f .k8s/manifests/01-facts-pod.yaml
$ kubectl get pods -n k8slab -o wide
$ kubectl describe pod facts-raw -n k8slab
$ kubectl logs -n k8slab facts-raw
$ kubectl -n k8slab exec -it facts-raw -- env | grep COUNTER
$ kubectl port-forward -n k8slab pod/facts-raw 8000:8000
```

**What it proves.** `describe` shows the Pod scheduled onto a worker node,
image loaded, container Ready. `logs` is the service's own stdout. `exec --
env` drops a shell *inside the container* and shows `COUNTER_URL` landing as
a real env var. `port-forward` is your personal wire to that one Pod —
temporary and Pod-specific.

**The lesson of this phase — cattle, not pets:**

```console
$ kubectl delete pod facts-raw -n k8slab
$ kubectl get pods -n k8slab
No resources found in k8slab namespace.
```

You deleted it, and *it stays gone*. Nothing recreates a raw Pod. A Pod is
cattle: replaceable, expected to die. Want something that survives? Declare
*how many* you want and let a controller maintain that — which is P2.
(Cleanup per the runbook: `kubectl delete -f .k8s/manifests/01-facts-pod.yaml`.)

---

## 4. P2 · Deployments & Services

### 4.1 Deployments: the reconciliation loop

**Concept.** A **Deployment** is a controller that owns N identical Pods.
You declare a desired state; a control loop constantly compares it to
reality and *fixes the difference* — desired 1, actual 0 → start one;
desired 1, actual 3 → kill two. This loop, not you, keeps services alive:

<!-- source: .k8s/manifests/10-facts.yaml -->
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: facts
  namespace: k8slab
  labels:
    # ... standard labels elided
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: facts
  template:
    metadata:
      labels:
        app.kubernetes.io/name: facts
        app.kubernetes.io/part-of: k8slab
```

The wiring that makes the loop work:

- `spec.replicas` — how many Pods you want: the desired state.
- `spec.template` — the cookie cutter: a Pod blueprint (same shape as P1's
  `spec.containers`).
- `spec.selector.matchLabels` — **which Pods this Deployment adopts**; the
  template's labels MUST match it, because the controller finds its Pods *by
  label*. This label-matching is the load-bearing trick of all Kubernetes —
  Services use the same mechanism in a moment.

**Run — the self-heal demo:**

```console
$ kubectl apply -f .k8s/manifests/
$ kubectl -n k8slab delete pod -l app.kubernetes.io/name=facts
$ kubectl get pods -n k8slab -w
```

**What it proves.** Delete the facts Pod and a *new one with a generated
name* (`facts-<suffix>-<suffix>`) appears within seconds, Ready again — the
same command that permanently killed `facts-raw` in P1 is a no-op on the
system here. (The apply brings up all phase-2 objects; 30/40 lie dormant
until P4/P5, and 01 may recreate the raw Pod — delete it.)

**Run — scale out and watch load balance:**

```console
$ kubectl -n k8slab scale deployment facts --replicas=3
$ kubectl -n k8slab port-forward svc/frontend 8081:80    # then use the dashboard
$ kubectl logs -n k8slab -l app.kubernetes.io/name=facts --prefix
```

**What it proves.** `scale` edits `replicas` — the loop now maintains 3.
Hit the dashboard repeatedly and the logs' `--prefix` shows requests landing
on **different pod names**: something spreads load across them. That
something is a Service.

### 4.2 Services: a stable IP and DNS name for a shifting set of Pods

**Concept.** Pods die and come back with new IPs. A **Service** is a stable
virtual IP + DNS name load-balancing across *whatever Pods its selector
matches* — a moving target hidden behind one address.

<!-- source: .k8s/manifests/11-facts-service.yaml -->
```yaml
apiVersion: v1
kind: Service
metadata:
  name: facts
  namespace: k8slab
  labels:
    # ... standard labels elided
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: facts
  ports:
  - name: http
    port: 8000
    targetPort: http
```

- `type: ClusterIP` (the default): a cluster-internal virtual IP — reachable
  from any pod, invisible from your laptop (that's what port-forward and,
  in P4, ingress are for).
- `selector` → matches the Deployment's template labels, so it tracks exactly
  those Pods — which is why `facts-raw`'s different label in P1 mattered.
- `port` is the Service's port; `targetPort: http` is the *named* container
  port from the Pod template.
- DNS: inside the namespace the Service is simply `facts`; cross-namespace
  `facts.k8slab.svc.cluster.local` — automatic, the cluster runs its own DNS.

**Run / what it proves:**

```console
$ kubectl -n k8slab get svc facts
$ kubectl -n k8slab get endpoints facts
```

`endpoints` lists one internal IP per ready Pod — scale to 3 (above) and you
watch it grow to 3 rows, live. The Service is not the Pods; it is the list
of them.

### 4.3 How the frontend uses them

The nginx frontend reaches the services *by their Service DNS names* — no
`resolver` tricks as in the docker lab, because Service DNS is stable:

<!-- source: frontend/nginx.conf -->
```nginx
    location /api/facts {
        proxy_pass http://facts:8000/facts;
        ...
    }

    location /api/image {
        proxy_pass http://image:8080/image;
        ...
    }

    # Trailing-slash prefix mapping: /api/load/status?x=1 -> /load/status?x=1
    location /api/load/ {
        proxy_pass http://loadgen:9000/load/;
        ...
    }
```

`facts`, `image`, `loadgen` there are Service names — plain cluster DNS.
This one config is why the dashboard's cards and Load panel all work through
a single origin.

**Run — port-forward a Service (not a Pod):**

```console
$ kubectl -n k8slab port-forward svc/frontend 8081:80
```

**What it proves.** Open http://localhost:8081 — the dashboard, every card
live. Two caveats the lab teaches by experience: the tunnel is a *single
shared front door* (kill it and all cards fail at once while the cluster is
perfectly healthy — check `kubectl get pods`), and it binds to one specific
Pod, so a frontend redeploy points it at a dead Pod — re-run port-forward
after each frontend rollout. P4's Ingress solves both.

---

## 5. P3 · Config & health

### 5.1 ConfigMap: configuration without a rebuild

**Concept.** The same image should run in dev and prod with different
settings, so config lives *outside* the image. A **ConfigMap** is a named
bag of key/values the cluster injects into Pods as env vars (or files).

<!-- source: .k8s/manifests/05-configmap.yaml -->
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: k8slab-config
  namespace: k8slab
  labels:
    # ... standard labels elided
data:
  COUNTER_URL: http://counter:3000
  FACTS_URL: http://facts:8000
```

The consumption side (loadgen reads `FACTS_URL` the same way):

<!-- source: .k8s/manifests/10-facts.yaml -->
```yaml
        env:
        - name: COUNTER_URL
          valueFrom:
            configMapKeyRef:
              name: k8slab-config
              key: COUNTER_URL
```

The chain: ConfigMap key → env var → read at startup by the service:

<!-- source: facts/main.py -->
```python
    counter_url = os.environ.get("COUNTER_URL", COUNTER_URL_DEFAULT).rstrip("/")
```

**When Pods pick config up: only at start.** Env is resolved at container
start — change the ConfigMap and running Pods never notice. Restart them
(`kubectl -n k8slab rollout restart deploy/facts`): no rebuild, but yes a
restart.

**Run — the missing-ConfigMap demo:**

```console
$ kubectl -n k8slab exec deploy/facts -- env | grep COUNTER
$ kubectl -n k8slab delete configmap k8slab-config
$ kubectl -n k8slab rollout restart deploy/facts && kubectl -n k8slab get pods -w
```

**What it proves.** New facts Pods stick in **`CreateContainerConfigError`**
— Kubernetes refuses to start a container whose env source is gone. Re-apply
(`kubectl apply -f .k8s/manifests/05-configmap.yaml`) and they start: a
failed config reference is loud, not silent.

### 5.2 Secret: same idea, for credentials

<!-- source: .k8s/manifests/06-secret.yaml -->
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: k8slab-secret
  namespace: k8slab
  labels:
    # ... standard labels elided
type: Opaque
data:
  WIKI_API_KEY: c3VwZXItc2VjcmV0LWRlbW8=
```

**Concept.** A **Secret** is a ConfigMap-shaped object for credentials,
consumed the same way (`secretKeyRef`). This lab's is deliberately consumed
by *nothing* — no real API key — it exists to be read back:

```console
$ kubectl -n k8slab get secret k8slab-secret -o jsonpath='{.data.WIKI_API_KEY}' | base64 -d; echo
super-secret-demo
```

**base64 is encoding, not encryption** — anyone with read access sees the
plaintext. `kubectl describe secret` withholds values (sizes only); `-o
jsonpath` does not. Real secrecy is RBAC and encrypted etcd, not base64.

### 5.3 Health probes: Kubernetes checking on your containers

**Concept.** A process can be running but broken. **Probes** are the
container's health checks, defined in the Deployment:

- **liveness** — "is this container worth keeping alive?" Failing repeatedly
  → the container is *restarted*.
- **readiness** — "is this container ready to serve traffic?" Failing → the
  Pod is pulled from Service endpoints, but NOT restarted.

Readiness protects *others* from a Pod that can't serve yet (warming up);
liveness protects the Pod *from itself* (deadlocked — only a restart helps).
Both point at the same endpoint here:

<!-- source: .k8s/manifests/12-counter.yaml -->
```yaml
        readinessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 2
          periodSeconds: 5
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 10
```

(Path is per-app — the image service exposes `/healthz`.)

**Run — the liveness demo:**

```console
$ kubectl -n k8slab exec deploy/counter -- kill 1
$ kubectl -n k8slab get pods -n k8slab -w
```

**What it proves.** `kill 1` kills PID 1 — the whole container. Watch
`RESTARTS` tick to 1 and the same Pod come back Ready: you didn't restart
it, the kubelet did, per the liveness probe. A raw Docker container killed
the same way would just be dead — reconciliation applied *inside* a Pod.

---

## 6. P4 · Ingress

**Concept.** Services are cluster-internal; port-forward is a dev tunnel
bound to one Pod. An **Ingress** is a declarative L7 (HTTP) load balancer —
one object saying "requests matching this path go to that Service" — and real
infrastructure: survives redeploys, no terminal to keep open, one address.

An Ingress needs a **controller** to enforce it (the object is just data);
this lab uses ingress-nginx, installed from the official kind recipe
(upstream manifest — applied, not stored in the repo):

<!-- concept -->
```console
$ kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
$ kubectl -n ingress-nginx patch deploy ingress-nginx-controller \
    -p '{"spec":{"template":{"spec":{"nodeSelector":{"ingress-ready":"true"}}}}}'
```

One gotcha this lab hit live: the upstream manifest no longer pins the
controller to the `ingress-ready` node (it ships only `kubernetes.io/os:
linux`), so the pod can land on a worker — where nothing maps host port
8090 — and `localhost:8090` stays dark. The patch restores the classic kind
recipe's placement. Here P0 pays off: the controller must run on the node
labeled
`ingress-ready=true`, where `extraPortMappings` already forwards your
localhost:8090 to node port 80 — the controller binds it and the lab
answers at http://localhost:8090. (8090 because the github_actions lab's
cluster holds the old host port when both labs run together.) The Ingress
itself:

<!-- source: .k8s/manifests/30-ingress.yaml -->
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: k8slab-ingress
  namespace: k8slab
  labels:
    # ... standard labels elided
spec:
  ingressClassName: nginx
  rules:
  - http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: frontend
            port:
              number: 80
```

- One rule with **no host** matches every request; path `/` with
  `pathType: Prefix` sends *everything* to the frontend Service — the only
  one it routes to. The frontend nginx is already the `/api/*` gateway: one
  front door, one layer that understands paths.
- Why not route `/api/facts` straight to facts here? Ingress paths *match*
  prefixes but can't *strip* them — facts serves `/facts`, not `/api/facts` —
  so a direct route would need a `rewrite-target` annotation: a second layer
  doing what the frontend already does. Hence: don't.

**Run:**

```console
$ kubectl apply -f .k8s/manifests/30-ingress.yaml
$ kubectl -n k8slab get ingress
$ curl -I http://localhost:8090/
```

**What it proves.** The dashboard at http://localhost:8090 — with no
port-forward running. Close every tunnel; it still answers. (The manifest's
commented-out second path lets you watch ingress-nginx reconfigure live.)
Port-forward was a window; this is a door.

---

## 7. P5 · Autoscaling

### 7.1 The HPA control loop

**Concept.** The **HorizontalPodAutoscaler** is a third reconciliation loop:
it reads live CPU usage, compares it to a target, and edits the *Deployment's
`replicas`*, which the P2 loop then enforces. The loops compose.

<!-- source: .k8s/manifests/40-hpa.yaml -->
```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: facts-hpa
  namespace: k8slab
  labels:
    # ... standard labels elided
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: facts
  minReplicas: 1
  maxReplicas: 6
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 60
  behavior: ...
```

(The `behavior` block tunes the pace: scale-up with no stabilization window,
up to +4 Pods per 30s; scale-down waits 60s of calm.) Read it as: watch the
`facts` Deployment; keep average CPU at 60% of each Pod's *request* (the
`cpu: 100m` from P2 — tiny on purpose so the percentage moves dramatically);
stay between 1 and 6 replicas.

**Prerequisite — metrics-server.** The HPA computes "average CPU" from
metrics kind does not serve by default; without it, `kubectl get hpa` shows
`<unknown>` and nothing scales (the lab's own lesson). Install it — from the
manifest header, verbatim:

<!-- source: .k8s/manifests/40-hpa.yaml (header) -->
```console
$ kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
$ kubectl patch deployment metrics-server -n kube-system --type='json' -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
```

(The patch is kind-specific: self-signed kubelet certs fail the default
verification there.)

### 7.2 The loadgen, and why its Pod needs permissions

The load generator makes the demo a button in the UI instead of a shell
script: `POST /load/start` with `{durationSec, concurrency}` keeps
`concurrency` requests *in flight* against facts until the deadline — each
one the CPU-burning `?spin=true` path:

<!-- source: loadgen/server.js -->
```js
const FACTS_BASE = process.env.FACTS_URL || 'http://facts:8000';
const LOAD_TARGET = `${FACTS_BASE}/facts?topic=load-test&spin=true`;
```

It also reads the facts Deployment's *live replica count* from the Kubernetes
API so the UI can show it — and that's the interesting part: **a Pod talking
to the API server needs an identity and explicit permission** (by default it
has none). That's the ServiceAccount + RBAC objects of `07-loadgen-rbac.yaml`;
the Pod claims the identity:

<!-- source: .k8s/manifests/16-loadgen.yaml -->
```yaml
      serviceAccountName: loadgen
```

and the grant is least privilege — one verb, one named resource:

<!-- source: .k8s/manifests/07-loadgen-rbac.yaml -->
```yaml
rules:
- apiGroups: ["apps"]
  resources: ["deployments"]
  verbs: ["get"]
  resourceNames: ["facts"]
```

**Run / what it proves:**

```console
$ kubectl auth can-i get deployments/facts --as=system:serviceaccount:k8slab:loadgen -n k8slab   # yes
$ kubectl auth can-i list deployments --as=system:serviceaccount:k8slab:loadgen -n k8slab        # no
```

`yes` to the one thing it needs, `no` to even *listing* — anything else is
denied by the API server. (`POD_NAMESPACE` there is the "downward API": the
Pod reading its own metadata.)

### 7.3 The demo

```console
$ kubectl -n k8slab apply -f .k8s/manifests/40-hpa.yaml
$ kubectl -n k8slab get hpa -w
```

then in the dashboard: the Load Simulator panel — duration **60s**,
concurrency **20**, **Start Load**. The badge counts down while the terminal
shows the loop closing: TARGETS `<unknown>/60%` becomes `123%/60%`, replicas
climb 1 → 2 → … → 6, per-Pod CPU falls as load spreads, and ~a minute after
Stop they drain back. `kubectl top pods -n k8slab` shows the raw numbers.

**What it proves.** Nobody scaled anything by hand. Usage went up, a control
loop noticed, it edited another control loop's input, and Pods appeared —
P2's Deployment, P3's resource requests, P5's HPA and the loadgen's RBAC
working as one system.

**Finale — rollouts.** Deployments keep history: every change to the pod
template creates a revision you can inspect and undo.

```console
$ kubectl -n k8slab rollout history deploy/facts
$ kubectl -n k8slab rollout undo deploy/facts
```

**What it proves.** `rollout history` lists revisions; `undo` re-applies the
previous one and Pods roll over to it (`rollout status deploy/facts` watches
it happen). Combined with the build loop below, this is the deploy half of
"ship a change".

---

## 8. Images & the build side

**Concept.** Kubernetes runs images; it does not build them. Every service
has a Dockerfile under `.docker/<service>/` (build files out of the code
dirs), one per language — for example:

<!-- source: .docker/facts/Dockerfile -->
```dockerfile
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

RUN useradd --create-home appuser
USER appuser

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

(Slim base, dependencies before code for layer caching, non-root user. The
others: `node:20-alpine` for counter/loadgen, a two-stage Go build for
image, stock nginx plus files for the frontend.)

**The kind gotcha.** Your docker daemon built these images — but the cluster
nodes are *separate containers with their own image caches*: `k8slab/facts:v1`
is invisible inside them, and a Pod referencing it would sit in
`ErrImagePull` (a public-registry image would simply pull — hence
`imagePullPolicy: IfNotPresent`). The fix: hand the image to the nodes:

**Run — the build → load → deploy loop:**

```console
$ docker build -t k8slab/facts:v1 -f .docker/facts/Dockerfile facts/
$ kind load docker-image k8slab/facts:v1 --name k8slab
$ kubectl -n k8slab rollout restart deploy/facts
```

(Counter, image, loadgen build the same way; multiple images load in one
`kind load` command. The frontend differs:)

```console
$ docker build -t k8slab/frontend:v1 -f .docker/frontend/Dockerfile .
```

— note the **`.`** context: the image bakes in `frontend/*.html`,
`frontend/nginx.conf` AND this `GUIDE.md` from the repo root, plus a pinned
markdown renderer downloaded at build time (offline at runtime). **GUIDE.md
is content of the image**: editing it changes nothing until the image is
rebuilt, loaded and redeployed. The build's `nginx -t` gate is its "test".

**What it proves.** Change any service's code, run its three lines, and
`rollout status` shows old Pods replaced by new ones — zero downtime.

---

## 9. Map of the lab

| File | Teaches | Phase |
|---|---|---|
| `.k8s/kind-cluster.yaml` | kind: nodes-as-containers, extraPortMappings for ingress | P0 |
| `.k8s/manifests/00-namespace.yaml` | namespaces group and isolate | P1 |
| `.k8s/manifests/01-facts-pod.yaml` | raw Pod anatomy; cattle, not pets | P1 |
| `.k8s/manifests/05-configmap.yaml` | config decoupled from images | P3 |
| `.k8s/manifests/06-secret.yaml` | Secrets vs ConfigMaps; base64 ≠ encryption | P3 |
| `.k8s/manifests/07-loadgen-rbac.yaml` | ServiceAccount + Role + RoleBinding, least privilege | P5 |
| `.k8s/manifests/10-facts.yaml` | Deployment, reconciliation, label wiring, probes, resources | P2/P3 |
| `.k8s/manifests/11-facts-service.yaml` | ClusterIP Service, selector → endpoints, named targetPort | P2 |
| `.k8s/manifests/12-counter.yaml` | second workload; liveness restart demo | P2/P3 |
| `.k8s/manifests/13-counter-service.yaml` | cluster DNS replaces docker network aliases | P2 |
| `.k8s/manifests/14-image.yaml` | third workload; per-app probe paths | P2/P3 |
| `.k8s/manifests/15-image-service.yaml` | service-to-service routing | P2 |
| `.k8s/manifests/16-loadgen.yaml` | serviceAccountName, downward API (POD_NAMESPACE) | P5 |
| `.k8s/manifests/17-loadgen-service.yaml` | exposing the load generator | P5 |
| `.k8s/manifests/18-frontend.yaml` | nginx as gateway; port-forward target pre-ingress | P2/P4 |
| `.k8s/manifests/19-frontend-service.yaml` | the Ingress's backend target | P4 |
| `.k8s/manifests/30-ingress.yaml` | L7 path routing; why one gateway | P4 |
| `.k8s/manifests/40-hpa.yaml` | autoscaling control loop; metrics-server prerequisite | P5 |
| `facts/` + `.docker/facts/` | FastAPI service; env-driven config (COUNTER_URL) | P1–P5 |
| `counter/` + `.docker/counter/` | Express service; request logs you watch scale | P2 |
| `image/` + `.docker/image/` | Go service; `/healthz` convention | P2/P3 |
| `loadgen/` + `.docker/loadgen/` | in-cluster load + K8s API client (RBAC) | P5 |
| `frontend/` + `.docker/frontend/` | nginx proxy by Service DNS; dashboard + this guide | P2/P4 |

---

## 10. Teardown & next steps

The whole cluster is disposable — that's the point of kind:

```console
$ kind delete cluster --name k8slab
```

Everything — nodes, Pods, loaded images, the kubeconfig context — is gone.
The lab is designed to be re-created from scratch in minutes (P0, build/load
images, P1…): infrastructure as files, not as pets.

Where to go next, in a sensible order:

1. **ResourceQuotas / LimitRanges** on the `k8slab` namespace — one that must
   stay inside a budget (you already have the requests/limits vocabulary).
2. **ConfigMaps as files** (`volumes` + `volumeMounts`) — the other
   consumption mode; compare its reload behavior with the env-at-start rule.
3. **StatefulSets + PersistentVolumes** — the workload type this lab
   deliberately avoids: stable identity and disks surviving Pod replacement
   (what a database needs).
4. **Read the cluster itself** — `kubectl api-resources`, `kubectl explain
   deployment.spec`, `kubectl -n k8slab get events --watch`.

Happy clustering — when in doubt, `kubectl describe` the thing.
