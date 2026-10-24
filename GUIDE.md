# Kubernetes A–Z — a complete course, taught from a real cluster

This is the teaching guide for the **k8slab** lab: a real Kubernetes cluster
(a **kind** cluster — Kubernetes-in-Docker) on your own machine, five small
services in four languages, a full set of numbered manifests, and one practice
runbook (phases **P0–P5**, reproduced in [Part II](#part-ii--the-lab)).
Everything you will read about Kubernetes here is *demonstrated by files in
this repository* — the YAML is the source of truth, not this prose.

The best part: the lab *serves this guide itself*. The frontend is an nginx
container that bakes this file (`GUIDE.md`) into its image at build time,
along with a vendored markdown renderer — so the page you are reading is
served by a Pod, through an Ingress, from inside the cluster it describes.
The dashboard (the *app* of the lab) lives one path away at `/app.html`.

The teaching style, chapter by chapter:

1. **Concept** — the topic explained in plain words, from zero.
2. **On the cluster:** — the `kubectl` command whose output *shows you the
   thing*, because in Kubernetes you can watch every abstraction live.
3. **Code** — a snippet quoted *from this repo* (or, for topics this lab
   deliberately does not use, a clearly-marked concept example).

How to read the snippets:

- A comment line `<!-- source: path -->` above a code block means: *these lines
  are copied verbatim from that file in this repository* (sometimes shortened
  with a `…` / `# ...` elision line). Open the file side-by-side; it is the
  source of truth.
- A comment line `<!-- concept -->` means: *illustrative example only — this
  project does not use this feature* (usually because a simpler design chose
  otherwise). The guide never blurs the two. Unmarked `console` blocks are the
  lab's own runbook commands — safe to run as written while the lab is up.

The guide has two parts:

- **Part I — Fundamentals A–Z**: every core Kubernetes concept, ordered
  pedagogically, each grounded in this repo's real manifests where the lab
  exercises it (and honestly marked as concept-only where it doesn't).
- **Part II — The Lab**: this repository's architecture, the five services
  and their contracts, every manifest explained file by file, the P0–P5
  practice runbook, the build side, and the gotchas the lab hit live.

---

## How to run this lab

The whole lab runs on one machine with Docker. Prerequisites: Docker Desktop
running, `kind` and `kubectl` installed (`brew install kind kubectl` on a
Mac). Nothing touches a cloud; the cluster is disposable.

**1. Create the cluster** (nodes are plain Docker containers; ~30s of
`NotReady` after creation is normal — kind's CNI is still starting):

```console
$ kind create cluster --config .k8s/kind-cluster.yaml --name k8slab
$ kubectl get nodes -o wide
$ docker ps --filter label=io.x-k8s.kind.cluster=k8slab
```

**2. Build the five images.** Kubernetes runs images; it never builds them.
Four services build from their own code directory; the frontend is the
exception — it builds from the **repo root** (`.`), because it bakes in
`frontend/*.html`, `frontend/nginx.conf` AND this `GUIDE.md`:

```console
$ docker build -t k8slab/facts:v1    -f .docker/facts/Dockerfile    facts/
$ docker build -t k8slab/counter:v1  -f .docker/counter/Dockerfile  counter/
$ docker build -t k8slab/image:v1    -f .docker/image/Dockerfile    image/
$ docker build -t k8slab/loadgen:v1  -f .docker/loadgen/Dockerfile  loadgen/
$ docker build -t k8slab/frontend:v1 -f .docker/frontend/Dockerfile .
```

**3. Hand the images to the cluster.** The kind nodes are containers with
their *own* image caches — your local `k8slab/*:v1` images are invisible to
them until loaded:

```console
$ kind load docker-image k8slab/facts:v1 k8slab/counter:v1 k8slab/image:v1 \
    k8slab/loadgen:v1 k8slab/frontend:v1 --name k8slab
```

**4. Apply the manifests and work the runbook.** The fastest path to "lab
up": apply everything, install the two add-ons the later phases need
(ingress controller, metrics-server — exact commands in
[Part II](#part-ii--the-lab)), then browse. Two doors:

- **http://localhost:8090** — the Ingress route (host port 8090 is mapped in
  `.k8s/kind-cluster.yaml`; works with no tunnel running). 8090 because the
  sibling github_actions lab's cluster holds 8080 when both run together.
- **http://localhost:8081** — the port-forward alternative, for before the
  Ingress exists: `kubectl -n k8slab port-forward svc/frontend 8081:80`
  (8081 avoids both ingress ports).

Both URLs serve this guide at `/` and the dashboard at `/app.html`.

**Teardown anytime** — the whole point of kind is that the cluster is a
throwaway:

```console
$ kind delete cluster --name k8slab
```

Nodes, Pods, loaded images, the kubeconfig context — gone. Re-creating the
lab from scratch is minutes (steps above). The full practice runbook, phase
by phase with teaching commands, is in
[Part II — The Lab](#part-ii--the-lab).

---

# Part I — Fundamentals A–Z


## 1. Why Kubernetes exists — the scheduling problem

*Mostly concept — but knowing where a tool came from tells you why its
abstractions look the way they do.*

Picture running one container: `docker run` — trivial. Ten containers on one
machine: a compose file — still fine. Now hundreds of containers across tens
of machines, and ask: **which machine runs which container?** (CPU and memory
are finite and different per machine.) What happens when a container dies at
3am? When a machine dies? When traffic triples and you need more copies
*right now*, then fewer an hour later? When a new version must roll out
without dropping a request? When two teams' workloads must not starve each
other?

Every one of those questions is a **scheduling and reconciliation** problem,
and solving them by hand (or by cron script) does not survive contact with
production. An **orchestrator** is a system that owns them: you describe the
*workloads* and the *desired state*, and it continuously places them,
restarts them, scales them, and wires their networking. Kubernetes is the
orchestrator that won the ecosystem.

The lineage:

- **Borg (Google, mid-2000s)** — Google's internal cluster manager, running
  essentially everything Google operated. Two of Kubernetes' defining ideas
  come straight from Borg: *declarative desired state with reconciliation
  loops* (you say what, the system converges) and *labels as the grouping
  mechanism* (not names, not hierarchy — free-form tags that selectors
  query).
- **Omega (Google, ~2011)** — Borg's successor internally; refined the
  pattern of many parallel controllers against one shared store.
- **Kubernetes (2014)** — Google open-sourced a re-implementation of a
  decade of those lessons, written in Go, donated to the newly founded
  **CNCF** (Cloud Native Computing Foundation, part of the Linux Foundation)
  at version 1.0 in July 2015. "K8s" is numeronym shorthand.
- **Today** — the CNCF's flagship graduated project, the default answer to
  "how do we run containers in production", with every cloud offering a
  managed version.

One design consequence is worth internalizing immediately, because it is the
reason everything else in this guide works: **Kubernetes is a set of control
loops, not a script.** You never tell it "start container X on machine Y".
You declare "I want 3 of these, healthy" — and *it* decides where, fixes
drift, and keeps fixing it forever. Every chapter that follows is either a
new thing you can declare or a new loop that enforces a declaration.

The same night shift, both ways:

<!-- concept -->
```text
without an orchestrator              with an orchestrator
──────────────────────               ──────────────────────
"api-7 died, page someone"           (loop notices, restarts it)
"machine full? eyeball df"           (scheduler reserved CPU up front)
"traffic spike! scale by hand"       (autoscaler edits the replica count)
"deploy = pray at 2am"               (rollout: surge, check, roll back)
```


**On the cluster:** even "what is this thing" is a queryable fact — version
of both your client and the server, and the nodes the orchestrator owns:

```console
$ kubectl version
$ kubectl get nodes
```

## 2. The vocabulary — cluster, node, control plane, pod

Every later chapter hangs off eight nouns. Learn them once here, then watch
each get its own chapter:

- **Cluster** — the whole system: all machines plus the brain that manages
  them. One Kubernetes installation.
- **Node** — one machine (real or virtual) that runs workloads. In this lab,
  three nodes, and — kind's trick — each node is itself a plain Docker
  container on your laptop.
- **Control plane** — the brain: the components that decide where things run
  and notice when reality drifts. Usually on dedicated machines nobody else
  touches.
- **Data plane** — everything else: the nodes that actually run your
  containers. Also called worker nodes. "Control plane vs data plane" is the
  same split as "brain vs muscle".
- **Pod** — the smallest thing Kubernetes schedules: one or more containers
  that share an IP address and a lifecycle (§6). You never schedule "a
  container"; you schedule a Pod that contains one.
- **Workload** — the generic word for "thing that runs Pods": a Deployment,
  a Job, a DaemonSet… (§9, §20–22).
- **Object** — anything stored in the cluster's database: a Pod, a Service,
  a Secret… Every object has a *spec* (what you want) and a *status* (what
  actually is) — the reconciliation loop compares exactly these two.
- **Manifest** — a YAML (or JSON) file describing objects: the declarative
  input you hand to the cluster. Everything in `.k8s/manifests/` is one.

This lab gives the words something to point at — a control-plane node plus
two workers, which are Docker containers you can literally `docker exec`
into:

<!-- source: .k8s/kind-cluster.yaml -->
```yaml
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

(Note what this file is *not*: a Kubernetes resource. It is kind's own
config — fed to `kind create cluster`, never `kubectl apply`'d. In a cloud
cluster you'd instead click a console or call an API, and the control plane
would be invisible to you.)

**On the cluster:** `kubectl get nodes -o wide` lists the three nodes with
real internal IPs and roles; `docker ps --filter label=io.x-k8s.kind.cluster=k8slab`
shows *the same three things as containers* — the lab's standing demo that
"a node is just a machine":

```console
$ kubectl get nodes -o wide
NAME                 STATUS   ROLES           AGE   VERSION   INTERNAL-IP
k8slab-control-plane Ready    control-plane   10m   v1.xx.x   172.18.0.2
k8slab-worker        Ready    <none>          10m   v1.xx.x   172.18.0.3
k8slab-worker2       Ready    <none>          10m   v1.xx.x   172.18.0.4
```

## 3. The control plane — the brain, and reconciliation

The control plane is four cooperating components (five in cloud installs).
None of them is mystical; each is just a process:

- **kube-apiserver** — the front door. *Everything* — kubectl, controllers,
  the kubelets on every node — talks to the API server over HTTPS. It
  validates requests, enforces permissions (§18), and reads/writes the
  store. There is exactly one entry point; nothing bypasses it.
- **etcd** — the cluster's database: a distributed key-value store holding
  every object's spec and status. The API server is the *only* client. If
  etcd is lost, the cluster's entire declared reality is lost (running
  containers would keep running, but the brain would be empty — which is why
  etcd backups *are* cluster backups).
- **kube-scheduler** — the placement engine. When a new Pod has no node, the
  scheduler picks one: filters out nodes that don't fit (not enough CPU,
  taints the Pod won't tolerate, §24), scores the survivors, and writes the
  choice onto the Pod. It never starts anything itself — it only decides
  *where*; the node does the starting.
- **kube-controller-manager** — a bundle of **controllers**: small loops,
  each owning one object type (Deployment controller, ReplicaSet controller,
  Endpoint controller, …). Watch, compare, act — see below.

(A fifth, the cloud-controller-manager, appears in cloud clusters — the
same bundle idea for talking to the cloud's APIs: load balancers, node
provisioning. Never visible in a kind lab.)

The core idea, worth reading twice: **reconciliation**. Every controller runs
the same loop forever:

<!-- concept -->
```text
for {
    desired := read desired state  (the object's spec)
    actual   := read actual state   (the live cluster / status field)
    if actual != desired {
        act to make actual == desired   (usually: write another object)
    }
    sleep briefly
}
```

Nobody sends "restart pod X" commands. The Deployment loop sees desired 3 /
actual 2 and creates a Pod; the scheduler sees an unscheduled Pod and picks
a node; the kubelet (§4) sees a Pod on its node without containers and
starts them. Desired state in, convergence out — the pattern you will meet
again in Services (§12), HPAs (§23), and Operators (§27).

**On the cluster:** the control plane components run as ordinary Pods on the
control-plane node (created directly by kubeadm, not by any Deployment —
"static pods"). Names say it all:

```console
$ kubectl get pods -n kube-system -o wide | grep -E 'apiserver|etcd|scheduler|controller'
```

## 4. The node — kubelet, kube-proxy, runtime, CNI

The data plane's counterpart of "four components" is three per node:

- **kubelet** — the node's agent. It watches the API server for Pods
  assigned to *this* node, and drives the container runtime to make them
  real: pull image, create container, run probes (§10), restart on failure,
  report status back. It is the reconciliation loop's hands-on end: the
  scheduler decides *where*, the kubelet makes it *so*.
- **Container runtime** — the thing that actually runs containers:
  containerd by default (Docker's engine, minus the Docker CLI layers),
  spoken to over the **CRI** (Container Runtime Interface). You can see the
  runtime name and version right in node output — see below.
- **kube-proxy** — the networking half of Services (§12). It programs the
  node's kernel (iptables or IPVS rules) so that traffic to a Service's
  virtual IP lands on one of that Service's actual Pods. Without it, the
  stable IPs of §12 would be unroutable numbers.

Plus one cluster-wide piece that every node participates in: the **CNI
(Container Network Interface) plugin** — the component that gives every Pod
its own routable cluster IP (flat "pod network"), so any Pod can reach any
other without NAT. Kubernetes itself ships none; the cluster installs one at
creation. This lab's kind cluster uses **kindnet**, and its slow start is
your first real debugging experience: for ~30 seconds after `kind create
cluster`, `kubectl get nodes` shows `NotReady` — the node is reporting that
its CNI is not up yet, and until it is, no Pod can be scheduled. Watching a
node's conditions (`kubectl describe node`) is how you tell that story
apart from a real breakage.

<!-- concept -->
```text
   Pod sandbox created by containerd  ←── kubelet drives it (CRI)
   Pod IP assigned by the CNI         ←── kindnet in this lab
   Service IP routed by kube-proxy    ←── iptables/IPVS rules per node
   DNS served by CoreDNS              ←── a Deployment in kube-system (§13)
```

**On the cluster:** the `-o wide` columns expose the machinery — runtime
name and version per node, plus the internal IPs the pod network lives on:

```console
$ kubectl get nodes -o wide
NAME   ...   CONTAINER-RUNTIME
k8slab-control-plane   ...   containerd://1.x.x
```

## 5. kubectl and the declarative model

`kubectl` is your window into the API server — nothing more, nothing less.
Every command it offers ends up as an HTTPS call against the API (add `-v=6`
to watch). The verb families you will actually use:

- **Read**: `get` (list objects — `-o wide`, `-o yaml`, `-o json`),
  `describe` (the human-readable story: spec, status, events), `logs`,
  `top`.
- **Write**: `apply -f file.yaml` (declare desired state), `edit`, `patch`,
  `scale`, `delete`, plus imperative generators like `kubectl run`.
- **Interrogate**: `explain` (built-in docs for any field —
  `kubectl explain pod.spec`), `api-resources` (every object type your
  server knows), `diff`, `--dry-run`.

The mental model that separates Kubernetes users from Kubernetes
appreciators: **desired vs actual state**. `apply` does not mean "do this";
it means "record this as what should be, and converge towards it".
The imperative style still exists for quick experiments — and the
difference is visible in the command itself:

<!-- concept -->
```console
$ kubectl create deployment web --image=nginx --replicas=3   # imperative: a command
$ kubectl apply -f deployment.yaml                           # declarative: a fact
```

The first *does* something once (and leaves no file behind describing it);
the second *asserts* something the cluster then maintains.
Concretely, `apply` performs a **three-way merge** — your new file, the
object's live spec, and the *last version you applied* (kept in an
annotation) — so fields someone else manages survive your apply. Delete a
Pod that a Deployment wants, and the system brings it back; delete the
Deployment itself, and nothing does — the *declaration* was the source of
the Pods' existence.

The two safety valves you should use before every real change:

<!-- concept -->
```console
$ kubectl diff -f .k8s/manifests/            # what apply WOULD change
$ kubectl apply --dry-run=server -f file.yaml  # validate against the real API
```

(`diff` exits non-zero when anything would change — in scripts that is a
feature, not an error. `--dry-run=client` checks only local syntax; `server`
round-trips through the API server, catching bad fields and rejected
admission without saving anything.)

One bit of plumbing: `kubectl` talks to whichever **context** (cluster +
credentials + default namespace) is current in `~/.kube/config`. `kind
create cluster` wrote a `kind-k8slab` context and switched to it; `kubectl
config get-contexts` shows all you have. Most confusion between two
clusters is two contexts.

**On the cluster:** this lab's whole manifest directory is one declarative
world — apply it, read it back, then let `diff` prove the loop converged:

```console
$ kubectl apply -f .k8s/manifests/
$ kubectl -n k8slab get all
$ kubectl diff -f .k8s/manifests/ && echo "converged: no differences"
```

## 6. Pods — the atom of scheduling

A **Pod** is the smallest unit Kubernetes will place on a node. It wraps one
or more containers that are *co-scheduled, co-located, and share fate*: one
IP address, one set of storage volumes, one hostname (`localhost` between
them works), one life. If any container in a Pod dies the whole Pod is
affected; if the Pod is rescheduled, all its containers move together.

Why wrap containers at all? Because some things genuinely belong together —
an app and its log shipper (§26), a service and its local proxy — and
"scheduling" them separately would risk one running without the other.
Most Pods, including every Pod in this lab, hold exactly one container; the
Pod is still the atom because *Kubernetes cannot schedule less than one*.

The lab starts from a raw Pod — no controller above it — its entire
manifest:

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

Read it as three stanzas — `apiVersion`/`kind` (which API object: "a v1
Pod"; Deployments live under `apps/v1`, HPAs under `autoscaling/v2`),
`metadata` (identity: name, namespace, labels), `spec` (the desired shape:
image, port, env). Every manifest in `.k8s/manifests/` is this shape; only
`kind` and `spec` change.

A Pod's lifecycle is a small state machine, and `kubectl get pods` shows
the current state in its STATUS column:

<!-- concept -->
```text
Pending ──► Running ──► Succeeded     (run-to-completion workloads, §22)
   │           │
   │           └──► Failed            (a container exited nonzero)
   └── stuck here = scheduler or image problem: describe it (§29)
```

Two details doing quiet work: `imagePullPolicy: IfNotPresent` because the
image is pre-loaded into the kind nodes (§Part II) and a registry pull would
fail; and `COUNTER_URL` pointing at a Service that does not exist *yet* —
facts only calls it per request, so the Pod starts fine and the calls fail
until the counter Service arrives: missing dependencies degrade, they don't
cascade-crash.

A Pod's lifecycle is a small state machine. **Pending** (accepted, no node
or containers not yet up) → **Running** (at least one container up) →
**Succeeded**/**Failed** (only meaningful for run-to-completion workloads,
§22). `kubectl get pods` shows it live; `kubectl describe pod` tells you
*why* a Pending Pod is stuck.

One spec field completes the picture: `restartPolicy` (`Always` by
default; `OnFailure` and `Never` for run-to-completion workloads, §22) —
what the kubelet does when a container exits. With `Always`, a crashed
container restarts in place forever (§10's demo relies on this); with
`Never`, the Pod just moves to `Failed`.

A multi-container Pod, for contrast — the lab deliberately has none:

<!-- concept -->
```yaml
spec:
  containers:
  - name: app
    image: my-app:1.0
  - name: log-shipper
    image: fluent-bit:3.0     # shares the Pod IP; reaches app on localhost
```

**On the cluster:** the five verbs of the raw-Pod phase — create, read,
describe, log, port-forward:

```console
$ kubectl apply -f .k8s/manifests/00-namespace.yaml -f .k8s/manifests/01-facts-pod.yaml
$ kubectl get pods -n k8slab -o wide
$ kubectl describe pod facts-raw -n k8slab
$ kubectl logs -n k8slab facts-raw
$ kubectl -n k8slab exec -it facts-raw -- env | grep COUNTER
$ kubectl port-forward -n k8slab pod/facts-raw 8000:8000
```

Then the lesson the raw Pod exists to teach — delete it and it *stays gone*:

```console
$ kubectl delete pod facts-raw -n k8slab
$ kubectl get pods -n k8slab
No resources found in k8slab namespace.
```

Nothing recreates a bare Pod. A Pod is cattle: replaceable, expected to die.
If you want something that survives, you don't make the Pod tougher — you
put a controller above it (§8). (Lab cleanup per the runbook:
`kubectl delete -f .k8s/manifests/01-facts-pod.yaml`.)

## 7. Labels, selectors, annotations

Three small mechanisms carry an outsized share of Kubernetes' weight.

**Labels** are free-form key/value pairs on any object (`metadata.labels`),
meant for *grouping*. They are not unique, not hierarchical, not owned by
anyone — which is their power: any object can carry
`app.kubernetes.io/name: facts` and any query can find all that do. The
whole lab uses one convention, from the shared
[recommended labels](https://kubernetes.io/docs/concepts/overview/working-with-objects/common-labels/):

<!-- source: .k8s/manifests/01-facts-pod.yaml -->
```yaml
  labels:
    app.kubernetes.io/name: facts-raw
    app.kubernetes.io/part-of: k8slab
```

**Selectors** are queries over labels. `-l` on the command line, or
`selector:` in a manifest: the label set that *some other object* points at.
This is the load-bearing trick of Kubernetes: controllers find the Pods they
manage *by label* (§8), and Services find the Pods they route to *by label*
(§12) — never by name, never by IP. Nothing is "registered" anywhere; the
connection is just matching tags. The lab's raw Pod proves the point
deliberately: it is labeled `facts-raw`, *not* `facts`, so the later facts
Service can never accidentally select it.

Two flavors of selector (the second, concept-only — this repo uses the
first everywhere):

<!-- concept -->
```yaml
selector:
  matchLabels:            # equality — every pair must match exactly
    app.kubernetes.io/name: facts
  matchExpressions:       # set-based — In / NotIn / Exists / DoesNotExist
  - key: tier
    operator: In
    values: [frontend, backend]
```

**Annotations** (`metadata.annotations`) look identical to labels but are
for *non-identifying* metadata: data for tools, not for selectors — build
info, contact, checksums, or configuration consumed by a controller like the
ingress (§14's `rewrite-target` aside is an annotation). You already met the
most famous one without knowing: `kubectl apply` stores the last applied
manifest in the `kubectl.kubernetes.io/last-applied-configuration`
annotation — the third input of §5's three-way merge.

**On the cluster:** selectors slice every `get`; `--show-labels` reveals
what's attached:

```console
$ kubectl -n k8slab get pods -l app.kubernetes.io/name=facts
$ kubectl -n k8slab get pods --show-labels
$ kubectl -n k8slab get pods -l app.kubernetes.io/part-of=k8slab -o wide
```

## 8. ReplicaSet and the reconciliation loop, self-healing

A raw Pod dies and stays dead (§6). The fix is not a better Pod — it is a
**controller**: an object whose whole job is running a reconciliation loop
(§3) over Pods. The simplest one that matters is the **ReplicaSet**: *keep N
identical Pods alive*. Nothing more — no versions, no rollout strategy
(that's §9) — just N.

Its manifest is three familiar parts:

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

(This is the lab's real file — a Deployment, which is §9 — but the parts
shown are exactly the ReplicaSet's working parts. Read them as such.)

- **`spec.replicas`** — the desired count. This number *is* the desired
  state; everything else follows from comparing it to reality.
- **`spec.template`** — the cookie cutter: a full Pod blueprint (same shape
  as §6's `spec.containers`), stamped out per replica. This is why Pods made
  by controllers get generated names (`facts-6f9c7b8d4-tws2l`:
  controller-hash + random suffix) — they are instances, not individuals.
- **`spec.selector.matchLabels`** — *which Pods this controller adopts*.
  The rule with no exceptions: the template's labels must match the
  selector, because the controller finds its Pods by that label and would
  otherwise adopt (or orphan) the wrong set.

The loop in action — **self-healing**, the property people mean when they
say "Kubernetes restarts things":

```console
$ kubectl apply -f .k8s/manifests/
$ kubectl -n k8slab delete pod -l app.kubernetes.io/name=facts
$ kubectl get pods -n k8slab -w
```

Delete the facts Pod and a *new one with a new name* appears within seconds,
Ready again. The command that permanently killed `facts-raw` in §6 is a
no-op on the system here — the ReplicaSet loop saw 1 desired / 0 actual and
stamped another. The same loop handles scale both ways:
`kubectl -n k8slab scale deploy/facts --replicas=3` edits the desired count;
the loop kills or creates until reality matches. (The apply of the whole
directory brings up every lab object; the 30/40 manifests lie dormant until
their phases, and `01` may recreate the raw Pod — delete it again.)

In practice you almost never write a ReplicaSet yourself — you write the
Deployment that *owns* one (§9), and the ReplicaSet remains as the
mechanism under it. The reason to know it exists: when a rollout misbehaves,
`kubectl get replicasets` is where the history actually lives.

**On the cluster:** the loop's bookkeeping is visible — desired vs ready
counts, straight from the status half of the object:

```console
$ kubectl -n k8slab get deploy,rs -o wide
$ kubectl -n k8slab describe rs -l app.kubernetes.io/name=facts
```
## 9. Deployments and rollouts

A **Deployment** is a controller that owns a controller — it manages
ReplicaSets so that *changing the Pod template over time* is safe. You edit
what "a replica" is (new image, new env, new probe); the Deployment's loop
creates a *new* ReplicaSet for the new template and shifts replicas from old
to new without downtime, keeping a rollback trail of the old ReplicaSets.
That shift is a **rollout**.

The lab's five workloads are five Deployments (`10-` through `18-` in
`.k8s/manifests/`); this is the standard choice for long-running stateless
services, which is most of what anyone deploys.

Two strategies, and the knobs of the default:

<!-- concept -->
```yaml
spec:
  strategy:
    type: RollingUpdate          # default; the alternative is Recreate
    rollingUpdate:
      maxSurge: 25%              # may temporarily go OVER the count: +25%
      maxUnavailable: 25%        # may temporarily go UNDER: -25%
  # Recreate = kill all old Pods, then start new ones: downtime, but no
  # two versions ever coexist (some datastores require exactly that).
```

`maxSurge` and `maxUnavailable` trade speed for capacity/availability:
surging costs cluster resources while old+new overlap; unavailability costs
serving power but never over-commits. The defaults (25% each) suit most
services; `maxUnavailable: 0` + `maxSurge: 1` is the "never lose a replica"
posture.

Every template change creates a **revision** (a kept ReplicaSet). That is
the deploy half of "ship a change" — and the lab's P5 finale:

```console
$ kubectl -n k8slab rollout history deploy/facts
$ kubectl -n k8slab rollout undo deploy/facts
$ kubectl -n k8slab rollout status deploy/facts
```

`history` lists revisions (each with its change cause, if you annotate
`kubernetes.io/change-cause`); `undo` re-applies the previous revision (or
`--to-revision=2` a specific one) and rolls Pods back to it; `status` blocks
until the rollout settles. The shape of the history (illustrative
revision numbers):

<!-- concept -->
```console
$ kubectl -n k8slab rollout history deploy/facts
deployment.apps/facts
REVISION  CHANGE-CAUSE
3         kubectl set image deploy/facts facts=k8slab/facts:v2
2         kubectl apply --filename=... scaled probes
1         initial apply
```

Two more verbs you will want:
`rollout restart` (make a new revision with the *same* template — the clean
way to force Pod restarts after a ConfigMap change, §15) and
`rollout pause`/`resume` (freeze mid-rollout to run checks on the new
version before continuing).

One subtlety worth internalizing: changes to `spec.replicas` or labels do
NOT create a revision — only changes to the Pod *template* do. The HPA of
§23 exploits this, editing replicas constantly while revisions stay clean.

**On the cluster:** watch a rollout as it happens — the events narrate the
surge, and `status` tells you when the world is quiet:

```console
$ kubectl -n k8slab set image deploy/facts facts=k8slab/facts:v2
$ kubectl -n k8slab rollout status deploy/facts
$ kubectl -n k8slab rollout history deploy/facts
```

(In the lab, `v2` doesn't exist — the point is watching `rollout status`
report progress, then `rollout undo` back. Building a real `v2` is Part II's
build loop.)

## 10. Health probes — liveness, readiness, startup

A process can be running and still be broken: wedged, out of connections,
still warming caches. Kubernetes cannot guess — so you *tell* it, with
probes: periodic checks the kubelet performs against each container, each
kind with a different consequence for failing:

- **liveness** — "is this container worth keeping alive?" Failing
  `failureThreshold` times in a row → the kubelet *restarts the container*
  in place (restart count +1, same Pod).
- **readiness** — "is this container ready to serve traffic?" Failing → the
  Pod is pulled from its Service's endpoints (§12) but NOT restarted.
  Passing again → back in. This is how a Pod that needs 30s to warm up
  avoids getting traffic at second 1 — and how a Pod that's temporarily
  unhappy stops receiving requests instead of being killed.
- **startup** — for slow-starting apps: until it passes once, liveness and
  readiness don't run at all. Without it you tune
  `initialDelaySeconds` against your slowest-ever start.

The division of labor is the point: readiness protects *others* from a Pod
that can't serve; liveness protects the Pod *from itself* (only a restart
helps a deadlock). If you invert them — liveness that fails when a
*dependency* is down — the kubelet will cheerfully restart every Pod that
could have recovered on its own, and a blip becomes a stampede.

Every workload in this lab carries a liveness and a readiness probe (it is
the single clearest marker of "production-shaped" manifests):

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

The knobs beyond the two shown: `failureThreshold` (default 3), 
`timeoutSeconds` (default 1 — probe calls that hang longer count as
failed), `successThreshold` (for readiness: consecutive passes to re-enter
endpoints). Probe *mechanisms*: `httpGet` (status < 400 = pass — the
common case), `tcpSocket` (port accepts a connection), `exec` (command exit
0), `grpc`.

The third probe kind, for apps that take minutes to boot (the lab has
none — its services start in ~1s, hence the small `initialDelaySeconds`):

<!-- concept -->
```yaml
        startupProbe:
          httpGet:
            path: /slow-health
            port: 8080
          periodSeconds: 5
          failureThreshold: 36      # up to 3 minutes before liveness takes over
        readinessProbe: ...          # ignored until startup passes once
        livenessProbe: ...
```

Paths are per-app convention, not boilerplate — this lab's counter and
facts serve `/health`, the Go image service serves `/healthz`:

<!-- source: image/main.go -->
```go
	mux.HandleFunc("/healthz", healthHandler) // Kubernetes liveness/readiness convention
```

**On the cluster:** the lab's live liveness demo — kill PID 1 inside the
counter container and watch the kubelet, not you, put it back:

```console
$ kubectl -n k8slab exec deploy/counter -- kill 1
$ kubectl -n k8slab get pods -n k8slab -w
```

`RESTARTS` ticks to 1 and the same Pod returns to Ready. A plain Docker
container killed this way would simply be dead — this is reconciliation
applied *inside* a Pod (§8's loop notices the container, not just the Pod,
is gone).

## 11. Resources — requests, limits, QoS

Every container in a Pod can (and should) declare two resource numbers per
dimension (CPU, memory):

- **requests** — what the container is *guaranteed*. The scheduler uses
  this (§24): a Pod lands on a node only if the node has at least this much
  unreserved. Requests are *reservations*, not caps — they shape placement.
- **limits** — the *ceiling*. CPU limit exceeded → the container is
  throttled (slowed, not killed). Memory limit exceeded → the container is
  **OOMKilled** (kernel kills it; exit code 137; `kubectl get pods` shows
  `OOMKilled`), and per §10 the kubelet restarts it.

Units: CPU in **cores** or **millicores** — `100m` is one tenth of a core,
`1` is a full core. Memory in bytes' binary multiples — `128Mi`, `1Gi`.
A core of CPU is shareable across many containers; a GiB of memory is not —
which is why only memory limits kill.

The lab's main workload, deliberately tiny so the autoscaler of §23 has a
dramatic signal:

<!-- source: .k8s/manifests/10-facts.yaml -->
```yaml
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 256Mi
```

Requests and limits combine, per Pod, into a **QoS class** — the order in
which Pods get evicted when a node runs short (kubelet evicts BestEffort
first, Guaranteed last):

<!-- concept -->
```text
Guaranteed   every container sets requests == limits (both CPU and memory)
Burstable    at least one request set, and not all requests == limits
BestEffort   nothing set at all
```

This lab's Pods are all Burstable (requests < limits) — the honest middle
ground for services whose load varies. Two more facts worth carrying: you
can set a limit with no request (request defaults to the limit), and what
you *omit* you get defaults for — possibly from a `LimitRange` object
that a namespace admin uses to stamp defaults on everything (concept):

<!-- concept -->
```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: lab-defaults
  namespace: k8slab
spec:
  limits:
  - default:          # limit when a container sets none
      cpu: 500m
      memory: 256Mi
    defaultRequest:   # request when a container sets none
      cpu: 100m
      memory: 128Mi
    type: Container
```

**On the cluster:** requests and limits are visible from three angles —
what you asked for, what's reserved on nodes, and what's being consumed
(`top` needs metrics-server, §23):

```console
$ kubectl -n k8slab describe deploy facts | grep -A4 -i resources
$ kubectl describe nodes | grep -A10 'Allocated resources'
$ kubectl top pods -n k8slab
```

## 12. Services — one stable address for shifting Pods

Pods are mortal: delete one, reschedule one, roll one out (§9), and it comes
back with a *different IP*. Anything that dialed the old IP is now talking
to a memory. A **Service** solves it: one stable address (a virtual IP +
DNS name) that load-balances across *whatever Pods currently match its
selector* — a moving target hidden behind one front door.

The lab's facts Service, entire:

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

Three fields, one paragraph each:

- **`type: ClusterIP`** (the default) — a virtual IP reachable from inside
  the cluster, never from your laptop. It routes nowhere physical: kube-proxy
  (§4) programs rules on every node that pick a matching Pod per connection.
  The Service IP is load-bearing precisely because it *never changes*.
- **`selector`** — same mechanism as §8: label query. This Service selects
  exactly the Pods the facts Deployment stamps out, and *only* the
  *Ready* ones (readiness gates endpoints — §10's other half).
- **`ports`** — `port` is the Service's own port; `targetPort` is where
  traffic lands on the Pod. `targetPort: http` names the *container* port
  (from `ports: - name: http` in the Pod template) rather than a number —
  renumber the container port and the Service tracks it; the string is the
  indirection. If omitted, `targetPort` defaults to `port`.

How a Service knows which Pods are currently live: the EndpointSlice
controller (a §3 loop) watches Pods matching the selector and writes the
ready set into **EndpointSlice** objects:

```console
$ kubectl -n k8slab get svc facts
$ kubectl -n k8slab get endpoints facts
```

`get endpoints` lists one internal IP per ready Pod. Scale facts to 3 (§8)
and watch it grow to three rows, live: the Service *is* that list, kept
current by the cluster, not by you.

ClusterIP is one of four Service types (the others, concept-only — this lab
exposes nothing directly; §14's Ingress is the lab's single door):

<!-- concept -->
```yaml
spec:
  type: NodePort            # cluster IP + a port on EVERY node (30000-32767)
                            # -> http://<any-node-ip>:31234; the "no cloud,
                            # no ingress" way in from outside
  type: LoadBalancer        # NodePort + asks the CLOUD for an external load
                            # balancer (EKS/GKE/AKS); on kind, `extraPortMappings`
                            # is the hand-rolled stand-in (§14)
  type: ExternalName        # no proxying at all: a DNS CNAME to an outside
                            # name — for gradually migrating a dependency
```

A fifth variant, also concept: **headless** Services (`clusterIP: None`) —
skip the virtual IP, let DNS return each Pod IP directly; how StatefulSets
(§20) give their members individual identities.

**On the cluster:** the lab's five Services are all ClusterIP — internal
wiring by design; see each with its endpoints:

```console
$ kubectl -n k8slab get svc,endpoints
```

## 13. Cluster DNS and service discovery

Services give you a stable IP; DNS gives it a *name* — and names are how
code should find dependencies, because IPs are unmemorable and config-like.
A Kubernetes cluster runs its own DNS (the **CoreDNS** Deployment in
`kube-system`) which invents a name for every Service, on a fixed scheme:

<!-- concept -->
```text
<service>.<namespace>.svc.cluster.local      the FQDN, globally unique
  facts.k8slab.svc.cluster.local             -> 10.96.x.y (the ClusterIP)

inside the same namespace, DNS search paths complete short names:
  facts           ->  facts.k8slab.svc.cluster.local     (same ns)
  facts.k8slab    ->  facts.k8slab.svc.cluster.local     (cross-ns, short)
```

Namespaces (§17) are therefore DNS scopes: same-namespace lookups are a
plain word, cross-namespace need `name.namespace`. That is the entire
service-discovery mechanism — no registry, no service mesh: create a Service
and its name resolves everywhere in the cluster, seconds later.

The lab leans on this three times over. The facts Pod is *told* the counter
Service's DNS name via an env var (nothing is hardcoded):

<!-- source: .k8s/manifests/01-facts-pod.yaml -->
```yaml
    env:
    - name: COUNTER_URL
      value: http://counter:3000
```

The ConfigMap stores the same shape (§15):

<!-- source: .k8s/manifests/05-configmap.yaml -->
```yaml
data:
  COUNTER_URL: http://counter:3000
  FACTS_URL: http://facts:8000
```

And the frontend nginx proxies to services *by their DNS names* — possible
because Service DNS is stable, where Docker Compose IPs are not (a real
migration note, expanded in §30):

<!-- source: frontend/nginx.conf -->
```nginx
    location /api/facts {
        proxy_pass http://facts:8000/facts;
        ...
    }
```

Two more DNS facts that matter in practice: SRV records exist for named
ports (`_http._tcp.facts.k8slab.svc.cluster.local` — how some clients
discover port numbers), and individual Pods can get DNS names too (their
IP with dots as dashes, `10-244-0-5.k8slab.pod.cluster.local`) — only
when the cluster's DNS is configured to serve pod records, and rarely
relied upon; the stable name is always the Service's.

**On the cluster:** prove discovery from *inside* the cluster — run a
throwaway Pod whose whole life is one curl at the Service name:

```console
$ kubectl run curlpod --rm -it --image=curlimages/curl --restart=Never \
    -- curl -s "http://facts:8000/facts?topic=rocket"
$ kubectl -n kube-system get deploy coredns
```

(The `--rm` deletes the Pod when the command exits; `--restart=Never` makes
it a Pod, not a Deployment. The one-liner is a standard debugging tool —
§29.)

## 14. Ingress and ingress controllers

ClusterIP Services are invisible outside the cluster (§12), NodePort is a
port-number scavenger hunt, LoadBalancer needs a cloud. The clean answer
for HTTP: an **Ingress** — one declarative object describing *L7 routing*
("host X and path /api go to Service A, port 80; everything else to B"),
and one address for the whole cluster. Ingresses do TLS termination,
name-based virtual hosting, and path routing; they do *not* do arbitrary
TCP (databases stay on Services).

The non-obvious part, learned by everyone once: **the Ingress object is
just data**. Nothing happens until an **ingress controller** — a real
Deployment you install — watches Ingress objects and reconfigures an actual
proxy (ingress-nginx wraps nginx; alternatives wrap Envoy, Traefik, HAProxy).
`ingressClassName: nginx` on the Ingress is the claim ticket saying which
controller should implement it. One cluster can run several.

The lab's entire Ingress — one rule, no host, one backend:

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

No `host:` means the rule matches every request regardless of hostname;
`path: /` with `pathType: Prefix` matches every path — so *everything* goes
to the frontend Service, which is itself the `/api/*` gateway (§13's nginx
quotes). One front door, one layer that understands paths. The alternative
the manifest's header argues against, worth reading as a design lesson:
route `/api/facts` straight to facts *here*. Ingress paths match prefixes
but cannot strip them — facts serves `/facts`, not `/api/facts` — so it
would need a controller-specific `rewrite-target` annotation: a second
routing layer doing what the frontend already does. Hence: don't.

What a host-and-TLS Ingress looks like when you need it (concept — the lab
needs neither, and kind has no certificates):

<!-- concept -->
```yaml
spec:
  tls:
  - hosts: [app.example.com]
    secretName: app-tls          # a kubernetes.io/tls Secret (§16)
  rules:
  - host: app.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend: ...
```

Getting traffic *into* a kind cluster at all: kind nodes are containers, so
the lab's cluster config maps host port 8090 to port 80 on the control-plane
node (§2's `extraPortMappings`) — and the controller must therefore run on
*that* node, pinned by the `ingress-ready=true` label (§24 tells that
scheduling story). On a cloud, a LoadBalancer Service fronts the controller
instead; same controller, different door.

**On the cluster:** after installing ingress-nginx (exact commands and the
nodeSelector gotcha in [Part II](#part-ii--the-lab)), one object, one URL,
no tunnels:

```console
$ kubectl apply -f .k8s/manifests/30-ingress.yaml
$ kubectl -n k8slab get ingress
$ curl -I http://localhost:8090/
```

Port-forward (§29) was a window; this is a door — close every terminal and
the dashboard still answers at http://localhost:8090.

## 15. ConfigMaps — configuration without a rebuild

The same image should run in dev, staging and prod with different settings
— which forces config to live *outside* the image. A **ConfigMap** is a
named bag of key/value pairs the cluster injects into Pods at start. It is
the "environment variables file" of Kubernetes, as a first-class object:
versioned, inspectable, editable with `kubectl`, scoped to a namespace.

The lab's, entire:

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

Three ways a Pod can consume it — the lab uses the first, the others are
concept:

<!-- concept -->
```yaml
env:
- name: COUNTER_URL                      # 1. one key -> one env var
  valueFrom:
    configMapKeyRef: {name: k8slab-config, key: COUNTER_URL}
envFrom:
- configMapRef: {name: k8slab-config}    # 2. EVERY key -> an env var
volumeMounts:                            # 3. keys -> FILES (each key a file)
- name: conf
  mountPath: /etc/conf
volumes:
- name: conf
  configMap: {name: k8slab-config}
```

The lab's real consumption side, in the facts Deployment:

<!-- source: .k8s/manifests/10-facts.yaml -->
```yaml
        env:
        - name: COUNTER_URL
          valueFrom:
            configMapKeyRef:
              name: k8slab-config
              key: COUNTER_URL
```

…landing in the process like any env var would:

<!-- source: facts/main.py -->
```python
    counter_url = os.environ.get("COUNTER_URL", COUNTER_URL_DEFAULT).rstrip("/")
```

The rule that surprises everyone: **env-based config is resolved once, at
container start.** Change the ConfigMap and running Pods never notice —
their containers were stamped with values at creation. To pick a change up:
`kubectl -n k8slab rollout restart deploy/facts` (§9's same-template new
revision). No image rebuild, but yes a restart. (File-mode consumption is
finer-grained: mounted files eventually update — eventually, and only if
the app re-reads them; the honest pattern remains restart-or-reload.)

And the lab's live demo of a loud failure mode — delete the ConfigMap and
restart:

```console
$ kubectl -n k8slab exec deploy/facts -- env | grep COUNTER
$ kubectl -n k8slab delete configmap k8slab-config
$ kubectl -n k8slab rollout restart deploy/facts && kubectl -n k8slab get pods -w
```

New facts Pods stick in **`CreateContainerConfigError`**: Kubernetes
refuses to start a container whose env source is gone. Re-apply
(`kubectl apply -f .k8s/manifests/05-configmap.yaml`) and they start on
their own — the kubelet retries, no manual anything. A broken config
reference is *loud*, not silent: one of Kubernetes' best habits. (Limits:
a ConfigMap's total size maxes at 1MiB — big configs want files or an
object store; and `immutable: true` is a perf/clarity option for values
that should never drift.)

**On the cluster:** read the whole object back, keys and all:

```console
$ kubectl get configmap k8slab-config -n k8slab -o yaml
$ kubectl describe configmap k8slab-config -n k8slab
```

## 16. Secrets — same idea, for credentials

A **Secret** is the credentials-shaped sibling of the ConfigMap: same
consumption mechanics (`secretKeyRef`, `envFrom`, files — here mounted
defaulting to read-only, tmpfs-backed, and byte-limited), one different
rule: values are stored **base64-encoded** so arbitrary bytes (TLS keys,
tokens) survive YAML, and tooling treats them as sensitive
(`kubectl describe secret` prints sizes, never values — `-o jsonpath`
prints them happily).

The lab's, deliberately consumed by *nothing* (there is no real API key to
protect — it exists to be inspected):

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

`type: Opaque` means "arbitrary user data" — the generic kind. Typed kinds
exist with schemas (`kubernetes.io/tls` for cert+key, used by §14's TLS;
`kubernetes.io/dockerconfigjson` for registry credentials — how a private
image is pulled, concept here: the lab's images are pre-loaded instead).
`stringData:` is the writer's convenience: put plaintext in, the API
stores it encoded. The TLS shape, for when §14 grows certificates:

<!-- concept -->
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: app-tls
type: kubernetes.io/tls
stringData:                 # written plainly, stored base64
  tls.crt: |
    -----BEGIN CERTIFICATE-----
    ...
  tls.key: |
    -----BEGIN PRIVATE KEY-----
    ...
```

**base64 is encoding, not encryption.** Anyone who can *read* the Secret
sees the plaintext with one pipe:

```console
$ kubectl -n k8slab get secret k8slab-secret -o jsonpath='{.data.WIKI_API_KEY}' | base64 -d; echo
super-secret-demo
```

Real secrecy is layered elsewhere: RBAC (§18) on who may read Secrets;
encryption-at-rest for etcd (a control-plane config); and, in serious
deployments, Secrets that aren't in etcd at all — fetched at runtime from
Vault/cloud secret stores or synced in by tools like external-secrets or
sealed-secrets (concept — a GitOps-friendly way to keep encrypted values in
the repo and only the cluster can decrypt). The lab's lesson is the honest
baseline: treat Secret reads as credential access, always.

**On the cluster:** the contrast between the two views of the same object
is the whole chapter:

```console
$ kubectl -n k8slab describe secret k8slab-secret   # sizes only
$ kubectl -n k8slab get secret k8slab-secret -o yaml  # base64 values
```
## 17. Namespaces — grouping and soft isolation

A **namespace** is a named folder inside one cluster: most objects live in
exactly one, names are unique only *within* a namespace, and `kubectl`
commands are scoped by `-n` (or your context's default). One cluster, many
tenants or many environments or many concerns — the lab keeps everything in
one namespace of its own so it can be seen and deleted as a unit:

<!-- source: .k8s/manifests/00-namespace.yaml -->
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: k8slab
  labels:
    app.kubernetes.io/name: k8slab
    app.kubernetes.io/part-of: k8slab
```

A fresh cluster ships four namespaces, each a convention: **default**
(where you land when you forget `-n`), **kube-system** (the control plane
and add-ons — §3's pods live here), **kube-public** (rarely used, for
public info), **kube-node-lease** (node heartbeat leases). Installing
things into their own namespace (`ingress-nginx`, `metrics-server`'s
`kube-system`) is the standard hygiene the lab follows.

What namespaces actually give you — and what they don't:

- **Scoping, yes.** Names, RBAC Roles (§18), and DNS (§13:
  `facts.k8slab.svc.cluster.local`) are all namespace-scoped. A Role in
  `k8slab` grants nothing in `default`; the Service name `facts` means
  different things in different namespaces.
- **Resource accounting, yes.** A **ResourceQuota** caps what a namespace
  may consume in total (concept — the natural next exercise for this lab):

<!-- concept -->
```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute-budget
  namespace: k8slab
spec:
  hard:
    requests.cpu: "2"
    requests.memory: 2Gi
    limits.cpu: "4"
    pods: "20"
```

- **Hard security isolation, no.** Namespaces do not stop network traffic
  (any Pod can reach any Service in any namespace unless NetworkPolicies
  say otherwise — §25), and ClusterRoles (§18) can cross them. A namespace
  is an *organizational* boundary with soft edges; hard isolation between
  genuinely untrusted workloads wants separate clusters or
  namespace-plus-policies by design.

Note also what is *not* namespaced: cluster-scoped objects — Nodes,
PersistentVolumes, ClusterRoles, namespaces themselves. `kubectl api-resources
--namespaced=false` lists them, a surprisingly handy command.

**On the cluster:** list namespaces, see the lab's objects as one group,
and watch `get all` do namespace-scoped enumeration:

```console
$ kubectl get namespaces
$ kubectl get all -n k8slab
$ kubectl get pods --all-namespaces   # (or -A) the whole cluster at once
```

## 18. RBAC — identities and permissions

Every request to the API server answers two questions: *who are you?*
(**authentication**) and *may you?* (**authorization**). Kubernetes'
authorization model is **RBAC** — Role-Based Access Control — and this lab
exercises it for real: one of its Pods talks to the Kubernetes API and
needs explicit permission to do so.

The first surprise: Pods have identities. Every Pod runs as a
**ServiceAccount** (default: the namespace's `default` one), and its token
is (by default) mounted into the Pod — that is the credential its API
calls present. Human users are the other identity kind, wired to the
cluster some other way (client certs, cloud IAM, OIDC) — outside this
guide's scope; everything below applies to both.

RBAC's four objects, in two pairs:

- **Role** — a namespace-scoped list of allowed operations. **ClusterRole**
  — the same, but cluster-scoped (for cluster-scoped resources, or to reuse
  across namespaces).
- **RoleBinding** — grants a Role to subjects (users, groups,
  ServiceAccounts) *in one namespace*. **ClusterRoleBinding** — grants a
  ClusterRole everywhere.

A ClusterRole in its natural habitat — permissions on a cluster-scoped
resource, where no namespace exists to host a Role:

<!-- concept -->
```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: node-reader
rules:
- apiGroups: [""]
  resources: ["nodes"]        # Nodes are cluster-scoped (§17)
  verbs: ["get", "list", "watch"]
```

The lab's, verbatim — the textbook least-privilege grant: one verb, on one
named resource:

<!-- source: .k8s/manifests/07-loadgen-rbac.yaml -->
```yaml
rules:
- apiGroups: ["apps"]
  resources: ["deployments"]
  verbs: ["get"]
  resourceNames: ["facts"]
```

Read it as a sentence: *in this namespace, allow `get` on the Deployment
named `facts` — nothing else.* `apiGroups` is the API's top-level
grouping (`apps` for Deployments, `""` for core objects like Pods and
Services, `rbac.authorization.k8s.io` for RBAC itself); verbs are the HTTP
semantics made friendly (`get`, `list`, `watch`, `create`, `update`,
`patch`, `delete`); `resourceNames` narrows the rule to specific named
objects — it scopes point-lookups like `get` (as here), and by nature
cannot scope a `create`.

The three-object chain — identity, permission, grant — from the same file:

<!-- source: .k8s/manifests/07-loadgen-rbac.yaml -->
```yaml
subjects:
- kind: ServiceAccount
  name: loadgen
  namespace: k8slab
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: loadgen-facts-reader
```

…and the Pod *claiming* the identity:

<!-- source: .k8s/manifests/16-loadgen.yaml -->
```yaml
      serviceAccountName: loadgen
```

Why this exists at all: the loadgen reads the facts Deployment's live
replica count from the API to show it in the UI (§23's demo). A Pod talking
to the API server needs an identity and explicit permission — by default a
`default` ServiceAccount can do almost nothing, which is exactly the right
default. The standing hardening note: disable the automatic token mount
(`automountServiceAccountToken: false`) on Pods that don't call the API —
which is every other Pod in this lab.

**On the cluster:** the best RBAC command is a question, `auth can-i` —
here asked *as the loadgen identity*, answering exactly what §7.2 of Part II
relies on:

```console
$ kubectl auth can-i get deployments/facts --as=system:serviceaccount:k8slab:loadgen -n k8slab   # yes
$ kubectl auth can-i list deployments --as=system:serviceaccount:k8slab:loadgen -n k8slab        # no
```

`yes` to the one thing it needs, `no` to even *listing* — anything else is
denied by the API server. Ask it as yourself sometime:
`kubectl auth can-i --list -n k8slab`.

## 19. Storage — PersistentVolumes, claims, StorageClasses

Pods are ephemeral; disks need to outlive them. Kubernetes splits storage
into three objects so that *the person deploying an app* never talks to
*the details of some specific disk on some specific machine*:

- **PersistentVolume (PV)** — a piece of storage the cluster *has*: a disk,
  a network share, a local path. Cluster-scoped. Provisioned by an admin…
  or automatically, which is the part that makes the model usable:
- **StorageClass (SC)** — a *recipe* for provisioning: "when asked, create
  a volume of type X on system Y". The dynamic-provisioning glue.
- **PersistentVolumeClaim (PVC)** — the app's side: "I want 5Gi, read-write,
  of the `standard` class". Namespace-scoped. A controller sees the claim,
  makes a volume per the class's recipe, binds them, and the Pod mounts the
  *claim* — never the volume directly.

The indirection pays off twice: the same app manifest works on any cluster
(the claim is portable; the volume is not), and the cluster can re-place
Pods while re-attaching the same claim to whichever node runs them next.
The classic shape (concept — this lab, stateless by design, mounts nothing:
its only volumes are the implicit, ephemeral, empty ones the runtime gives
every container):

<!-- concept -->
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: db-data
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: standard
  resources:
    requests:
      storage: 5Gi
---
# ... in the Pod template:
    volumeMounts:
    - name: data
      mountPath: /var/lib/postgresql/data
  volumes:
  - name: data
    persistentVolumeClaim:
      claimName: db-data
```

Vocabulary you'll meet in every PV/PVC discussion: **access modes** —
`ReadWriteOnce` (one node), `ReadOnlyMany`, `ReadWriteMany` (many nodes;
needs the *right* backend — NFS and friends, not a cloud disk); **reclaim
policy** — `Delete` (volume dies with the claim; the StorageClass default)
or `Retain` (volume survives, admin must release it); and
`volumeBindingMode: WaitForFirstConsumer` — delay binding until a Pod
actually needs it, so the volume lands on the *same zone as its consumer*
(the modern default; without it you can provision a volume in a region your
Pod will never be scheduled to).

Under it all sits **CSI** — the Container Storage Interface, the plugin
standard through which vendors (EBS, GCE PD, Azure Disk, Ceph, Longhorn…)
plug drivers into clusters. As a user you see only the StorageClass names.
kind ships one — a local-path class named `standard` — so
dynamic provisioning *works* on the lab cluster even though nothing uses
it: a good place to experiment.

**On the cluster:** see the machine's answers to "what storage exists /
what class would you give me":

```console
$ kubectl get storageclass
$ kubectl get pv,pvc -A
```

(`pv` empty is expected: nothing claimed. Creating the concept PVC above
in `k8slab` and re-running shows the full bind dance — a fine exercise.)

## 20. StatefulSets

*Concept — this lab is stateless on purpose; this is the workload type it
deliberately avoids, and the one you reach for the day you run a database
inside Kubernetes.*

A Deployment (§9) treats replicas as interchangeable cattle. Some things
aren't: a 3-node database where node `db-0` is the primary, each member has
*its own* data directory, and members find each other by *stable names*.
A **StatefulSet** guarantees exactly that, at the cost of the looseness
that makes Deployments cheap:

- **Stable identity** — Pod names are ordinals, not hash suffixes:
  `db-0`, `db-1`, `db-2` — the same names across reschedules, discoverable
  through a **headless Service** (§12: `clusterIP: None`), so DNS gives
  each Pod its own record (`db-0.db.default.svc.cluster.local`) that
  follows the Pod to any node.
- **Stable storage** — via `volumeClaimTemplates`: each ordinal gets *its
  own* PVC (`data-db-0`, `data-db-1`, …) that survives Pod replacement and
  re-attaches to the Pod wherever it lands (§19's mechanics, automated).
- **Ordered lifecycle** — by default Pods start 0, 1, 2 (each waits for its
  predecessor Ready) and shut down in reverse — what cluster-forming
  software expects.

<!-- concept -->
```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
spec:
  serviceName: db          # the headless Service governing its DNS
  replicas: 3
  selector:
    matchLabels: {app: db}
  template:
    metadata:
      labels: {app: db}
    spec:
      containers:
      - name: db
        image: postgres:16
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      resources:
        requests:
          storage: 10Gi
```

The honest engineering note: StatefulSets give you *mechanics*, not
operations — no backups, no failover, no upgrades. Running stateful systems
on Kubernetes well usually means an Operator (§27) that knows the product,
or keeping the database on a managed service outside the cluster. The
lab's counter/facts/image/loadgen need no disks precisely so the guide can
teach this paragraph as a warning instead of a lesson.

**On the cluster:** nothing to see — and that's the point this lab makes.
`kubectl -n k8slab get statefulsets` returns nothing; when you meet one in
the wild, its Pod names ending in `-0` are the tell.

## 21. DaemonSets

*Concept — the lab runs no per-node agents of its own, but its cluster
*does*: the CNI (§4) and kube-proxy ship as DaemonSets.*

A **DaemonSet** runs *one Pod per (matching) node*, automatically: add a
node, the DaemonSet's controller notices and starts a copy on it; remove
the node, the Pod goes with it. No `replicas` field — the node count *is*
the count. It is the workload type for **node-level software**: log
collectors, node exporters, security agents, storage drivers, network
plugins — anything whose answer to "how many?" is "one per machine, always
and everywhere":

<!-- concept -->
```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-exporter
  namespace: monitoring
spec:
  selector:
    matchLabels: {app: node-exporter}
  template:
    metadata:
      labels: {app: node-exporter}
    spec:
      hostNetwork: true        # see the node's real interfaces, not the pod net
      tolerations:             # control-plane nodes are tainted (§24) —
      - operator: Exists       # tolerate it or your agent skips the brain
```

Two details in that example carry most of the pattern's subtlety:
`hostNetwork: true` (a node agent often wants the node's view of the
network, /proc, /sys — available via the host namespaces) and the blanket
**toleration** — because control-plane nodes carry a `NoSchedule` taint in
standard clusters (§24), and an agent that doesn't tolerate it will be
absent exactly where debugging hurts most. (kind's control-plane node is
schedulable — one of kind's conveniences — but manifest portability says
tolerate anyway.)

**On the cluster:** the invisible infrastructure, visible — every Pod in
`kube-system` running on *every* node with no Deployment owning it:

```console
$ kubectl -n kube-system get ds
$ kubectl -n kube-system get pods -o wide | grep -E 'kindnet|kube-proxy'
```

## 22. Jobs and CronJobs

*Concept for the manifests; the pattern is everywhere — this lab simply has
no batch work to do.*

Deployments run things *forever*; a **Job** runs something *to completion*.
The Pod (§6) is the same; the controller's promise differs: N successful
completions, retries on failure, and a written record of the run. This is
batch: migrations, report generation, frame rendering, data exports.

<!-- concept -->
```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migrate
spec:
  backoffLimit: 4            # retries before the Job is Failed (default 6)
  completions: 1             # total successes wanted
  parallelism: 1             # run that many Pods at once
  ttlSecondsAfterFinished: 600   # auto-delete the finished Job (else it stays)
  template:
    spec:
      restartPolicy: Never   # Jobs must say Never or OnFailure, not Always
      containers:
      - name: migrate
        image: myapp:1.4
        command: ["./migrate.sh"]
```

`completions` × `parallelism` is the whole parallel-batch vocabulary: 10 ×
1 = a queue of ten run one at a time; 10 × 10 = all at once; 1 × 5 =
five-way work-gang on one task (work-queue style, each Pod pulls items
until done). The fields interact honestly with reality — if `parallelism`
Pods fail past `backoffLimit`, the Job fails; succeeded Pods are what
count, not attempts.

A **CronJob** is a Job generator on a crontab schedule — the five-field
`* * * * *` (minute hour day-of-month month day-of-week) you already know:

<!-- concept -->
```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly-report
spec:
  schedule: "17 3 * * *"
  concurrencyPolicy: Forbid   # a still-running previous run blocks the next
  successfulJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
          - name: report
            image: myapp:1.4
            command: ["./report.sh"]
```

Notes worth one read each: schedules are UTC by default (newer versions
accept an explicit `timeZone:` — set it or regret it); `concurrencyPolicy`
answers "the previous run hasn't finished and the schedule fired" —
`Allow` (default), `Forbid` (skip), or `Replace` (kill and restart); and
suspend: a CronJob with `suspend: true` is a parked schedule.

**On the cluster:** fire a one-off Job in the lab namespace and watch the
lifecycle — the fastest way to make §6's `Succeeded` phase real (note the
cross-namespace FQDN, §13):

```console
$ kubectl create job --image=curlimages/curl probe -- curl -s "http://facts.k8slab.svc.cluster.local:8000/facts?topic=job" -m 3
$ kubectl -n default wait --for=condition=complete job/probe --timeout=60s
$ kubectl -n default logs job/probe
$ kubectl -n default delete job probe
```

## 23. Autoscaling — the HPA control loop

Scaling is §3's reconciliation loop aimed at *replica count*: measure,
compare, adjust. The **HorizontalPodAutoscaler (HPA)** is the object that
owns the loop: read live metrics, compute the replica count that would hit
a target, and *edit the Deployment's `spec.replicas`* (§9 — which is why
the loops compose: HPA decides how many, the Deployment loop makes it so).

The lab's, complete (its P5 finale):

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
```

Read it as: *watch the facts Deployment; keep average CPU at 60% of each
Pod's request (§11's `100m` — tiny on purpose so percentages move
dramatically); stay between 1 and 6.* The loop's arithmetic, roughly:
`desired = current × (currentUtilization / targetUtilization)`, clamped to
min/max, with a 10% tolerance band so it doesn't flap at 59/61%.

The prerequisite this lab hit live: the HPA reads CPU from the **resource
metrics API**, served by **metrics-server** — which kind does not install.
Without it, `kubectl get hpa` shows `<unknown>` metrics and nothing scales
(the lab's own lesson). Install per the manifest header, verbatim:

<!-- source: .k8s/manifests/40-hpa.yaml (header) -->
```console
$ kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
$ kubectl patch deployment metrics-server -n kube-system --type='json' -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
```

(The patch is kind-specific: kubelet self-signed certs fail the default
verification there. metrics-server is also what powers `kubectl top`.)

Past `metrics`, HPAs scale on more than CPU: **Pods** custom metrics (e.g.
queue depth per pod, via an adapter — concept) and **External** metrics
(e.g. an SQS queue length — concept):

<!-- concept -->
```yaml
  metrics:
  - type: Pods
    pods:
      metric:
        name: http_requests_per_second      # served by a metrics adapter
      target:
        type: AverageValue
        averageValue: "100"
```

And the `behavior` block (present in
the lab's file, quoted in Part II) shapes *how fast*: scale-up with no
stabilization window and up to +4 Pods per 30s, scale-down waiting 60s of
calm — aggressive up, conservative down, exactly the shape you want under
traffic.

Two siblings complete the autoscaling family (concept): **VPA** — the
*Vertical* Pod Autoscaler, which watches and *recommends* (or applies,
restarting Pods) better `requests`/`limits` — the answer to "my requests
were guesses"; and the **cluster-autoscaler** (or a managed equivalent)
which adds/removes *nodes* when Pods would stay Pending (§24) or nodes sit
idle. KEDA (event-driven autoscaling) extends the same loop to queues and
streams. The lab uses none — one loop, understood deeply, teaches the
pattern they all share.

**On the cluster:** apply, then watch the loop close during a load run
(the loadgen drives it — Part II):

```console
$ kubectl -n k8slab apply -f .k8s/manifests/40-hpa.yaml
$ kubectl -n k8slab get hpa -w
$ kubectl top pods -n k8slab
```

TARGETS goes `<unknown>/60%` → `252%/60%`; replicas climb 1 → 6; per-Pod
CPU falls as load spreads; after the load stops, the stabilization window
passes and they drain back down. Nobody touched anything.

## 24. Scheduling deep dive — taints, affinity, cordon, drain

§3 hand-waved the scheduler as "filter, score, pick". This chapter opens
the box — *which* knobs decide where a Pod lands.

The scheduler's two passes over nodes:

1. **Filters** (feasibility): skip nodes that can't host the Pod — not
   enough unreserved CPU/memory (§11's requests!), Pod's tolerations
   don't cover the node's taints, nodeSelector/affinity says no, ports
   the Pod needs are taken.
2. **Scores** (optimality): rank survivors — least-requested resources,
   spreading replicas across nodes (`podAntiAffinity` and *topology
   spread constraints*, concept — "don't put all three replicas on one
   node" made declarative), data locality.

Then the placement machinery, in rough order of reach:

**nodeSelector** — the simplest constraint: a label the node must have.

**Node affinity** — nodeSelector with expressions and two moods:
`required` (hard) and `preferred` (soft, weighted). Concept:

<!-- concept -->
```yaml
affinity:
  nodeAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      nodeSelectorTerms:
      - matchExpressions:
        - key: kubernetes.io/arch
          operator: In
          values: ["arm64"]
    preferredDuringSchedulingIgnoredDuringExecution:
    - weight: 80
      preference:
        matchExpressions:
        - key: node-type
          operator: In
          values: ["spot"]
```

(The long names say something real: decisions are made *at scheduling
time* and *not enforced after* — a node whose labels change doesn't evict
anyone.)

**Taints and tolerations** — the reverse direction: marks on *nodes* that
repel Pods (a taint: `key=value:Effect`) and Pods' permission slips to
ignore them (tolerations). Effects: `NoSchedule` (don't place), 
`PreferNoSchedule` (try not to), `NoExecute` (evict existing too). The
canonical taint is on control-plane nodes
(`node-role.kubernetes.io/control-plane:NoSchedule`) keeping workloads off
the brain; §21's DaemonSet tolerated it blanket. The lab's live example is
the inverse trick — kind makes its control-plane node *schedulable*, and
the ingress chapter pins the controller *onto* it by label:

<!-- source: .k8s/kind-cluster.yaml -->
```yaml
  kubeadmConfigPatches:
  - |
    kind: InitConfiguration
    nodeRegistration:
      kubeletExtraArgs:
        node-labels: "ingress-ready=true"
```

…matching the install patch that steers the controller (from §14, shown
there in full): `nodeSelector: {ingress-ready: "true"}`. Label the node,
select the label — placement as two declarative halves.

**Cordon and drain** — the operational verbs for nodes you want to empty:
`kubectl cordon` marks a node unschedulable (no *new* Pods); `kubectl
drain` cordons *and* evicts existing Pods (gracefully, honoring their
controllers' §8 self-healing — the Pods land elsewhere). The standard
maintenance dance, safe *because* reconciliation exists:

<!-- concept -->
```console
$ kubectl cordon k8slab-worker2
$ kubectl drain k8slab-worker2 --ignore-daemonsets --delete-emptydir-data
# ... patch/reboot/replace the machine ...
$ kubectl uncordon k8slab-worker2
```

Last, the corner cases the filters can't fix: a Pod that fits *nowhere*
stays **Pending** forever (events say why — §29); **priority** and
**preemption** (concept) let a high-priority Pod bump lower ones off a
full cluster; and the scheduler only *places* — a Pending Pod because the
cluster is full is the cluster-autoscaler's signal (§23).

**On the cluster:** the placement facts, all queryable — labels, taints,
and what's reserved where:

```console
$ kubectl get nodes --show-labels
$ kubectl describe node k8slab-control-plane | grep -i taint
$ kubectl describe nodes | grep -A12 'Allocated resources'
```
## 25. NetworkPolicies

*Concept — the lab applies none, which is precisely the teachable state:
by default, every Pod in the cluster can reach every other Pod.*

Kubernetes' pod network (§4's CNI) is flat and open: any Pod → any Pod,
any namespace, any port — the connectivity model of one big friendly LAN.
A **NetworkPolicy** is how you say "no" — and the mental model that makes
them click is that they are **allow-lists, applied per selected Pod**:

- If *no* policy selects a Pod: everything is allowed (the default-open
  world).
- The moment *any* policy selects a Pod: that Pod accepts only what some
  policy explicitly allows — for each direction (ingress/egress) you list
  *who may talk to whom*, by label selectors, namespace selectors,
  IP/CIDR blocks, and ports. Everything unlisted is dropped.

<!-- concept -->
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: facts-only-from-frontend
  namespace: k8slab
spec:
  podSelector:
    matchLabels: {app.kubernetes.io/name: facts}   # WHO this policy guards
  policyTypes: [Ingress]
  ingress:
  - from:
    - podSelector:
        matchLabels: {app.kubernetes.io/name: frontend}   # allowed talkers
    ports:
    - protocol: TCP
      port: 8000
```

That policy, applied to the lab, would say: facts accepts TCP/8000 from
frontend Pods — and from nobody else, so loadgen's `/load` traffic (which
goes direct to facts, Part II) would instantly break: a nice reminder
that policies must be written from the *real* traffic map, not the
intended one.

Two more truths to carry: **policies are enforced by the CNI plugin, not
by Kubernetes itself** — a cluster whose CNI doesn't implement them will
happily accept your YAML and silently enforce nothing (always verify with
a connection test, never with `kubectl apply`'s exit code); and policies
have no `deny:` verb — the model is "select a Pod, then allow-list", and
"deny everything" is just "select a Pod and allow nothing":

<!-- concept -->
```yaml
spec:
  podSelector: {}          # every Pod in the namespace
  policyTypes: [Ingress, Egress]   # allow-list nothing = default-deny both ways
```

The standard hardening recipe for any real cluster: default-deny ingress
per namespace, then allow exactly the service-to-service edges your
architecture has — the traffic diagram in Part II, written as YAML.

**On the cluster:** prove the lab's default-open posture and the absence
of policies, then test connectivity the honest way — with a connection:

```console
$ kubectl get networkpolicies -A
$ kubectl run np-test --rm -it --image=curlimages/curl --restart=Never \
    -- curl -s -m 3 http://facts.k8slab.svc.cluster.local:8000/facts?topic=net
```

## 26. Init containers and the sidecar pattern

*Concept for the multi-container machinery — every lab Pod is deliberately
single-container — but the *pattern* is already in this guide: §6's "why
Pods wrap containers at all".*

Two roles for the non-main containers of a Pod spec:

**Init containers** (`spec.initContainers`) run *to completion, in order,
before* the main containers start. Each must succeed before the next
begins; any failure restarts the Pod (per its restartPolicy). That is
exactly the semantics "wait for my dependency" wants, which nothing else
in Kubernetes offers natively:

<!-- concept -->
```yaml
spec:
  initContainers:
  - name: wait-for-db          # runs, exits 0, THEN the app starts
    image: curlimages/curl
    command: ["sh", "-c", "until curl -s http://db:5432; do sleep 2; done"]
  containers:
  - name: app
    image: myapp:1.4
```

Compare §13's lab stance — facts *starts* without counter and fails
per-request until it appears — and you have the two legitimate designs in
one place: degrade-gracefully (no ordering) vs require-before-start (init
container). Databases that *must* exist before an app boots justify the
second; everything else is usually happier with the first.

Init containers differ from regular ones in small useful ways: they don't
support probes, they run sequentially (main containers are parallel), and
they see the Pod's volumes — perfect for populating a shared volume (fetch
config, generate certs, pre-warm a cache) before the app reads it.

**Sidecars** are *long-running* partner containers inside the same Pod —
alive as long as the app, sharing its IP (talk over `localhost`), its
volumes, and its fate (§6's definition). Classic roles: log shipping,
TLS/proxy (the "ambassador" — app speaks plaintext localhost, sidecar
speaks TLS to the world), metrics adaptation. Historically they were just
a second entry under `containers`; newer Kubernetes releases add
**native sidecars** — declared under `initContainers` with
`restartPolicy: Always`, which start first, stay up for the Pod's life,
and shut down *after* the main containers (fixing the teardown-order bug
in the old hack):

<!-- concept -->
```yaml
spec:
  initContainers:
  - name: log-shipper            # a NATIVE sidecar: init slot + always-restart
    image: fluent-bit:3.0
    restartPolicy: Always
    volumeMounts:
    - name: logs
      mountPath: /var/log/app
  containers:
  - name: app
    image: myapp:1.4
    volumeMounts:
    - name: logs
      mountPath: /var/log/app
```

The honest design note this lab models by restraint: a sidecar couples
your app's lifecycle to someone else's container — before adding one, ask
if the job belongs in the platform (an ingress, a DaemonSet agent, a
mesh) or in the app itself. Sidecars earn their keep when the logic is
genuinely per-Pod and genuinely not the app's business.

**On the cluster:** any real cluster is full of Pods you didn't write,
some multi-container — inspect one and read its anatomy:

```console
$ kubectl -n kube-system get pods | head -5
$ kubectl -n kube-system get pod -o jsonpath='{.items[0].spec.initContainers[*].name}'
```

## 27. Custom Resources and Operators

*Concept — none of this lives in the lab repo, but the lab's own machinery
(the Ingress of §14, the HPA of §23) is built on this pattern. Inversion,
one level up.*

Everything so far — Deployments, Services, HPAs — is a handful of types
compiled into Kubernetes. The API is not closed: a **CustomResourceDefinition
(CRD)** teaches the cluster a *new noun*, and the API server will store,
serve, validate and version it like a built-in. Create a CRD for
`databases.example.com` and minutes later `kubectl get databases` works —
your object, in the same store, behind the same auth (§18), watchable by
the same mechanisms.

<!-- concept -->
```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: databases.example.com
spec:
  group: example.com
  scope: Namespaced
  names:
    plural: databases
    kind: Database
  versions:
  - name: v1
    served: true
    storage: true
    schema:
      openAPIV3Schema:          # the API server validates against this
        type: object
        properties:
          spec:
            type: object
            properties:
              engine: {type: string, enum: [postgres, mysql]}
              size: {type: string}
```

A custom resource alone is *only data* — dumb storage. The second half is
a **custom controller**: your own process (a Deployment, typically)
watching your custom resources *and* the built-ins, running the §3
reconciliation loop over them. CRD + controller as a pair = an
**Operator**: operational knowledge ("how to deploy, back up, fail over,
and upgrade *this piece of software*") encoded as a program that runs the
loop for you. `kubectl apply` a `Database` object; the operator provisions
a StatefulSet (§20), a Service (§12), a PVC (§19), wires them, and keeps
them correct forever.

You have been using this pattern all guide long: `kind: Ingress` is data;
ingress-nginx is its controller (§14 — "the Ingress object is just data").
`kind: HorizontalPodAutoscaler` is data; an in-cluster loop enforces it
(§23). Operators generalize the trick to any domain: cert-manager
(`Certificate` CRDs → issued TLS secrets), Prometheus Operator
(`ServiceMonitor` CRDs → scrape configs), database operators per product.
Even the mechanics rhyme: §23's "HPA edits the Deployment's replicas" is
exactly what your operator would do.

**On the cluster:** the pattern is visible in your cluster's API surface —
these are the nouns this cluster was *taught*, beyond stock:

```console
$ kubectl api-resources | grep -v -E 'k8s.io$' | tail -5
$ kubectl get crd
```

## 28. Packaging — Helm and Kustomize

*Concept — the lab's 17 manifests are plain `kubectl apply`, which is the
right weight for a teaching lab; at real scale you will want one of these
two, and they solve different problems.*

Plain manifests repeat shamelessly: five Deployments that differ by name
and image; one app deployed to dev, staging and prod with three deltas
each. Two standard answers, with opposite philosophies:

**Helm** — the package manager: templates + values. A **chart** is a
directory of YAML templates with `{{ .Values.* }}` holes; installing with
different values files (or `--set` flags) fills them. Charts version,
install, upgrade and roll back as units; a public repository holds
thousands (`bitnami`, official charts). The mental model: apt/homebrew for
clusters.

<!-- concept -->
```yaml
# templates/deployment.yaml (inside a chart)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-{{ .Chart.Name }}
spec:
  replicas: {{ .Values.replicas }}
  template:
    spec:
      containers:
      - name: app
        image: "{{ .Values.image.repo }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
```

<!-- concept -->
```console
$ helm install facts ./charts/facts -n k8slab --set image.tag=v2
$ helm upgrade facts ./charts/facts -n k8slab -f values-staging.yaml
$ helm rollback facts 3 -n k8slab
$ helm list -n k8slab
```

**Kustomize** — the overlay engine: no templates, no new language — base
manifests plus declarative *patches* per environment. A `kustomization.yaml`
says "take these files, change these fields, add these labels"; `kubectl
apply -k dir` renders and applies. Built into kubectl, which is its
quiet superpower. The mental model: `diff`/`patch` for YAML, made first
class.

<!-- concept -->
```yaml
# overlays/staging/kustomization.yaml
resources:
- ../../base
patches:
- target: {kind: Deployment, name: facts}
  patch: |
    - op: replace
      path: /spec/replicas
      value: 1
```

Choosing between them, briefly: installing *other people's software*
(HAProxy, cert-manager, Grafana) — Helm, because that's where the
ecosystem publishes. Templating *your own* app across environments —
either works; Kustomize stays closer to your plain manifests (this lab's
17 files *would be* a Kustomize base almost unchanged), Helm pays off once
variants multiply and you want versioned releases. Many teams run both:
Helm for the platform, Kustomize (or plain) for the app.

**On the cluster:** nothing to run — the point of this chapter is that
`kubectl apply -f .k8s/manifests/` *is* a legitimate third option, and
this lab's numbering convention (00–40, one concept per file) is a
documentation strategy plain YAML buys you for free.

## 29. The debugging toolbox

Kubernetes' saving grace: everything is observable through one tool, and
almost every failure narrates itself in **Events**. A triage order that
works, from cheapest to most invasive:

**1. `get` — the shape of the world.** Status columns ARE the diagnosis
vocabulary: `Running`/`Pending`, `0/1` ready (unready — probe or
crashloop), RESTARTS climbing (crashloop — check `logs --previous`),
`OOMKilled`, `CreateContainerConfigError` (§15), `ErrImagePull` (image
missing where the node can see it — Part II's `kind load` lesson).
A crashloop as `get` shows it, and where each tool takes over:

<!-- concept -->
```console
$ kubectl get pods -n k8slab
NAME                    READY   STATUS             RESTARTS   AGE
facts-6f9c7b8d4-tws2l   0/1     CrashLoopBackOff   5          4m
$ kubectl -n k8slab logs facts-6f9c7b8d4-tws2l --previous   # why it died
```

**2. `describe` — the object's story.** Spec, status, events, in one
scroll. The last ~20 lines of `describe pod` are the cluster's error
console: *why* a Pod is Pending, *why* a probe fails, *when* it was
scheduled. If you remember one command from this guide: this one.

```console
$ kubectl -n k8slab describe pod -l app.kubernetes.io/name=facts
```

**3. Events, cluster-wide.** The same narratives as `describe`, but as a
stream across all objects — sorted by time, they are the cluster's
syslog. They expire (~1h); catch problems fresh.

```console
$ kubectl -n k8slab get events --sort-by=.lastTimestamp
$ kubectl get events -A --field-selector type=Warning
```

**4. `logs` — the app's own voice.** stdout/stderr of the container (the
whole logging contract: your app prints, the platform ships). `--previous`
is the killer flag — logs of the *last* crashed instance; `-l` +
`--prefix` reads a whole Deployment at once, pods named per line (§12's
load-balancing demo runs on exactly this):

```console
$ kubectl -n k8slab logs deploy/facts
$ kubectl -n k8slab logs deploy/facts --previous
$ kubectl logs -n k8slab -l app.kubernetes.io/name=facts --prefix
$ kubectl -n k8slab logs -f deploy/facts        # follow, tail -f style
```

**5. `exec` — a shell inside.** When logs aren't enough: run a command in
the live container. Debug DNS (§13) from *inside* the network you're
debugging; inspect env as the process sees it (§15's demo):

```console
$ kubectl -n k8slab exec -it deploy/facts -- sh
$ kubectl -n k8slab exec deploy/facts -- env | grep COUNTER
```

**6. `port-forward` — your personal wire.** Tunnel a local port to one
Pod or Service, for point-and-click access to something cluster-internal.
Two caveats the lab teaches by experience: it is *one shared front door*
(kill it and every tab dies at once while the cluster is perfectly
healthy) and it binds to one specific Pod (a rollout orphans the tunnel —
re-run it after redeploys; §14's Ingress solves both):

```console
$ kubectl -n k8slab port-forward svc/frontend 8081:80
```

**7. `top` — the resource truth.** Live per-Pod/container CPU and memory
(needs metrics-server, §23) — how you watch an HPA's input with your own
eyes:

```console
$ kubectl top pods -n k8slab
$ kubectl top nodes
```

Plus three reflection commands that answer "what can I even ask": `kubectl
api-resources` (every noun), `kubectl explain pod.spec.containers.resources`
(built-in schema docs, any depth), `kubectl get deploy facts -o yaml` (the
live object, all fields the server filled in — often the fastest way to
learn a field you've never set).

**On the cluster:** run the ladder on a healthy lab and read every rung —
the time to learn the toolbox is before the breakage.

## 30. From docker compose to Kubernetes

*This lab is the chapter — the same five services run in the sibling
docker/github_actions labs as compose stacks. Here is what the translation
actually looked like, fact by fact.*

The object mapping, honest about the asymmetries:

<!-- concept -->
```text
docker compose                Kubernetes
──────────────                ─────────────────────────────────────────
service: foo            →     Deployment (foo) + Service (foo)   [§9, §12]
  (one thing)                   (the workload AND its address split apart)
image: / build:         →     image: only — NOTHING builds images (Part II)
ports: "8080:80"        →     Service port + container port; exposure via
                              port-forward / Ingress, not host ports [§12,§14]
environment:            →     env: from ConfigMap / Secret       [§15, §16]
env_file:
networks: (shared)      →     the flat pod network + DNS — no network
                              objects for normal use [§4, §13]
volumes:                →     emptyDir (ephemeral) / PVC (durable) [§19]
depends_on:             →     nothing! no start ordering — use readiness
                              probes + init containers instead [§10, §26]
restart: always         →     the ReplicaSet loop — always on, structurally [§8]
deploy.replicas:        →     spec.replicas (+ HPA on top) [§8, §23]
```

Three rows deserve their own paragraph:

**`build:` has no equivalent — on purpose.** Kubernetes runs images; it
does not build them. The compose workflow (`up` → build → run) becomes a
deliberate pipeline: build → push/load → deploy (Part II's build loop;
real systems put CI there — the sibling github_actions guide is exactly
that pipeline). This is the single biggest workflow change, and it is
*good* pressure: what runs is a versioned artifact.

**`depends_on` doesn't translate — and shouldn't.** Compose can order
container *starts* (and with `condition: service_healthy`, wait for
health). Kubernetes has no start ordering between Deployments, because
Pods are cattle (§6): the equivalent posture is *make each service
tolerate its dependencies being absent* — readiness probes to gate traffic
(§10), init containers for genuine hard dependencies (§26), retries in
code. The lab's facts service is the case study: it starts happily while
counter doesn't exist and fails per-request until it does — degrade, don't
refuse to boot.

**Networking inverts from "join a network" to "everything is already
reachable, restrict if needed".** In compose, services on the same network
reach each other by alias; different networks are the isolation. In
Kubernetes, every Pod reaches every Pod by default; isolation is opt-in
(NetworkPolicies, §25). The lab's frontend shows the pleasant consequence
— in the compose lab, nginx needs a `resolver` directive because upstream
container IPs change under restarts; in Kubernetes, Service DNS is stable,
so plain `proxy_pass` just works — the config comment marks the migration:

<!-- source: frontend/nginx.conf -->
```nginx
    # Kubernetes Service DNS names are stable, so the upstreams can be
    # resolved once at startup and proxied with plain proxy_pass URIs
    # (no Docker-style resolver/variable deferral needed).
```

With all that, a
production-readiness checklist — what a migration must add beyond
"runs": **requests/limits** on every container (§11); **probes** on every
workload (§10); **config out of the image** into ConfigMaps/Secrets
(§15–16); a **stable name** per service (a Service) instead of container
DNS; a **single front door** (Ingress) instead of published ports; an
**identity and permissions** review for anything that talks to the API
(§18); and **multiple replicas + a rollout story** (§8–9) — cattle.

**On the cluster:** the lab IS the migrated system — five services, four
languages, no code changes needed for the move (only the nginx resolver
simplification); the manifests are the translation table above, one file
per row.

## 31. The wider ecosystem

*Concept — a map of what surrounds what you learned, so the next thing
you meet has a place to sit.*

**Local clusters** — kind (this lab: nodes as Docker containers, real
control plane, `kind load` for images — Part II) is one of a family:
**minikube** (a VM or container per cluster, broad driver support, mature
add-ons), **k3d** (clusters from k3s — a lightweight Kubernetes built for
the edge, so it also runs on real small hardware), **Docker Desktop's
built-in Kubernetes** (one cluster toggle, batteries included). All give
you a throwaway cluster on a laptop; pick by taste. The shared lesson
this lab already taught: treat clusters as cattle too — create, use,
`delete`, recreate.

**Managed control planes** — in the cloud, nobody runs the brain by hand:
**GKE** (Google), **EKS** (AWS), **AKS** (Azure) give you a control plane
they operate and nodes they (optionally) manage, billed by the hour. The
concepts in this guide transfer 1:1 — a Deployment is a Deployment —
what changes is the *integration surface*: `type: LoadBalancer` actually
provisions a cloud LB (§12), StorageClasses map to cloud disks (§19),
node pools and the cluster-autoscaler replace `docker ps` (§23–24).
Between "laptop kind" and "cloud managed" sits a spectrum (self-managed
on VMs, k3s on edge boxes) — the architecture is identical at every
scale, which is rather the point.

**GitOps** — the deployment philosophy this lab's runbook does by hand,
made declarative: the *git repo* is the desired state, and a controller
in the cluster (**Argo CD**, **Flux**) continuously reconciles live
cluster state towards it — §3's loop, one level up, with git as the spec:

<!-- concept -->
```text
   git repo (manifests = desired state)          cluster (actual state)
        ▲                                              │
        │ human: commit + revert                        │
        └──────────── Argo CD / Flux ◄─────────────────┘
                       (in-cluster reconciler: drift → fixed, changes → applied)
```

Push to git → the cluster converges; drift is visible, revert is
`git revert`. The lab's `.k8s/manifests/` directory is already the right
shape for exactly this.

**Adjacent machinery you'll meet soon after this guide**: **service
meshes** (Istio, Linkerd — sidecars [§26] or per-node proxies adding
mTLS, retries and traffic-splitting below the application), 
**cert-manager** (an Operator [§27] that issues and renews certificates
into Secrets [§16]), **observability stacks** (Prometheus + Grafana,
often installed *as* Operators, scraping metrics endpoints), and the
CNCF landscape at large — a famously huge map where the navigational
skill is exactly what this guide built: read any piece as *an object plus
a reconciliation loop* and it stops being intimidating.

Where this lab deliberately goes next (its own closing exercises):
ResourceQuotas on `k8slab` (§17's concept), ConfigMaps-as-files (§15's
mode 3), a StatefulSet with a PVC (§19–20) — and reading the cluster
itself until `kubectl explain` feels like a friend.

**On the cluster:** one last look at what you're actually standing on —
the API surface, the version, the nodes; the same three commands that
opened the guide, now legible end to end:

```console
$ kubectl api-resources | wc -l        # (approximately) how many nouns exist
$ kubectl version
$ kubectl get nodes -o wide
```
---

# Part II — The Lab

## The lab at a glance

One diagram, the whole system:

<!-- concept -->
```text
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
              └─────────────────────────────────────────────┘
```

In words: your browser hits the ingress controller at localhost:8090,
which forwards everything to the frontend Service. The frontend (nginx)
serves this guide and the dashboard as static files, and proxies
`/api/facts`, `/api/image` and `/api/load/` to the three Services by their
cluster DNS names. The facts service, per request, POSTs the text to
counter (`COUNTER_URL`, from the ConfigMap) and returns text + counts;
counter is *internal by design* — nothing outside the cluster calls it
(no `/api/count` exists). The loadgen drives facts directly for the
autoscaling demo. Outbound from the cluster: facts calls Wikipedia, image
calls Wikimedia Commons.

Five services, four languages, on purpose — Kubernetes doesn't care what
a container is built with, and neither should a Service selector. The
design decisions worth internalizing:

1. **One front door.** The Ingress routes only to the frontend; the
   frontend is the `/api/*` gateway (§14's "don't route /api/facts
   straight to facts" argument).
2. **Internal stays internal.** counter has a Service (cluster DNS) but
   no external path — reachability is a *design*, not an accident.
3. **Config is data.** The only cross-service addresses live in one
   ConfigMap (`05-configmap.yaml`), injected as env — nothing is
   hardcoded except code-level defaults (§13, §15).
4. **One concept per manifest.** Files are numbered 00–40 so the
   runbook's phases can apply them one idea at a time.

## Repository layout

<!-- concept -->
```text
kubernetes_developers_guide/
├── GUIDE.md                     ← this guide (the single docs file)
├── agentic_development.md       ← project state journal + practice runbook
├── devlog.md                    ← dated lab narratives (gotchas' origin story)
├── counter/                     ← Express service (Node)   :3000 POST /count
├── facts/                       ← FastAPI service (Python) :8000 GET /facts
├── image/                       ← Go service               :8080 GET /image
├── loadgen/                     ← Express load generator   :9000 /load/*
├── frontend/
│   ├── index.html               ← the guide page (fetches /GUIDE.md)
│   ├── app.html                 ← the dashboard (the "app")
│   ├── favicon.svg
│   └── nginx.conf               ← static serving + /api/* proxy (§13)
├── .docker/
│   ├── counter/Dockerfile  facts/Dockerfile  image/Dockerfile
│   ├── loadgen/Dockerfile  frontend/Dockerfile  ← repo-root build (see below)
│   └── (docker-compose files + .env — the CI/production side, outside
│        this guide's scope; same five services, docker compose flavor)
├── .k8s/
│   ├── kind-cluster.yaml        ← cluster definition (NOT a k8s resource)
│   └── manifests/00–40*.yaml    ← 17 numbered manifests, teaching headers
├── e2e/                         ← browser tests for the frontend
└── .github/workflows/           ← CI + production deploy (compose-based;
                                    the k8s lab itself runs locally)
```

The manifests' comment headers carry each phase's exact commands — they
are the runbook's twin, and several are quoted verbatim in this guide as
`source: … (header)`.

## The five services and their contracts

**counter** (Node/Express, `counter/server.js`) — `POST /count` with
`{"text": "..."}` → word/character/unique-word counts. `GET /health` for
probes. Logs one line per request (`METHOD path status`) — those logs are
§12's load-balancing demo.

**facts** (Python/FastAPI, `facts/main.py`) — `GET /facts?topic=octopus`
(usually with `&spin=true` under load): a Wikipedia summary, forwarded to
counter for counting, returned with counts included. The CPU-burning spin
path is calibrated to make autoscaling visible:

<!-- source: facts/main.py -->
```python
# CPU burn for ?spin=true (the autoscaling-lab signal path). Calibrated so one
# request burns roughly 30-80ms of CPU: ~2us per hash * 25000 hashes.
SPIN_HASHES = 25_000
```

Config arrives as an env var with a sane default (§15's chain):

<!-- source: facts/main.py -->
```python
COUNTER_URL_DEFAULT = "http://counter:3000"
```

**image** (Go, `image/main.go`) — `GET /image?topic=octopus`: a Wikimedia
Commons picture URL. `GET /healthz` — the per-app probe-path contrast of
§10:

<!-- source: image/main.go -->
```go
	mux.HandleFunc("/healthz", healthHandler) // Kubernetes liveness/readiness convention
```

**loadgen** (Node/Express, `loadgen/server.js`) — `POST /load/start` with
`{durationSec, concurrency}`: keeps `concurrency` requests in flight
against facts until the deadline; `GET /load/status`: counters; `GET
/load/replicas`: what the dashboard's replica badge reads (real count in
the cluster, simulated outside it — below). Its target is env-driven too:

<!-- source: loadgen/server.js -->
```js
const FACTS_BASE = process.env.FACTS_URL || 'http://facts:8000';
const LOAD_TARGET = `${FACTS_BASE}/facts?topic=load-test&spin=true`;
```

**frontend** (nginx, `frontend/nginx.conf`) — serves the dashboard and
this guide, proxies `/api/*` by Service DNS (§13 quoted the three
`proxy_pass` lines). This guide page itself:

<!-- source: frontend/nginx.conf -->
```nginx
    # The guide markdown, fetched by guide.html's renderer. nginx's stock
    # mime.types maps .md to application/octet-stream (browsers would offer a
    # download on direct visits) — serve it as text with an explicit charset.
    location = /GUIDE.md {
        default_type text/markdown;
        charset utf-8;
        charset_types text/markdown;
    }
```

## The manifests, file by file

| File | Teaches (guide chapter) | Phase |
|---|---|---|
| `.k8s/kind-cluster.yaml` | kind: nodes-as-containers, extraPortMappings 8090, ingress-ready label (§2, §24) | P0 |
| `00-namespace.yaml` | namespaces group and isolate (§17) | P1 |
| `01-facts-pod.yaml` | raw Pod anatomy; cattle, not pets (§6) | P1 |
| `05-configmap.yaml` | config decoupled from images (§15) | P3 |
| `06-secret.yaml` | Secrets vs ConfigMaps; base64 ≠ encryption (§16) | P3 |
| `07-loadgen-rbac.yaml` | ServiceAccount + Role + RoleBinding, least privilege (§18) | P5 |
| `10-facts.yaml` | Deployment, reconciliation, label wiring, probes, resources (§8–11) | P2/P3 |
| `11-facts-service.yaml` | ClusterIP Service, selector → endpoints, named targetPort (§12) | P2 |
| `12-counter.yaml` | second workload; liveness restart demo (§10) | P2/P3 |
| `13-counter-service.yaml` | cluster DNS replaces docker network aliases (§13) | P2 |
| `14-image.yaml` | third workload; per-app probe paths `/healthz` (§10) | P2/P3 |
| `15-image-service.yaml` | service-to-service routing (§12) | P2 |
| `16-loadgen.yaml` | serviceAccountName, downward API `POD_NAMESPACE` (§18) | P5 |
| `17-loadgen-service.yaml` | exposing the load generator (§12) | P5 |
| `18-frontend.yaml` | nginx gateway; port-forward target pre-ingress (§14) | P2/P4 |
| `19-frontend-service.yaml` | the Ingress's backend target (§14) | P4 |
| `30-ingress.yaml` | L7 path routing; one gateway; rewrite-target why-not (§14) | P4 |
| `40-hpa.yaml` | autoscaling loop; metrics-server prerequisite; behavior block (§23) | P5 |

The downward API, in `16-loadgen.yaml` — a Pod reading its own metadata
(no hardcoded namespace):

<!-- source: .k8s/manifests/16-loadgen.yaml -->
```yaml
        - name: POD_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
```

And the HPA's `behavior` block, promised by §23 (read it as: scale up
fast and hard, scale down only after a quiet minute):

<!-- source: .k8s/manifests/40-hpa.yaml -->
```yaml
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0
      selectPolicy: Max
      policies:
      - type: Pods
        value: 4
        periodSeconds: 30
    scaleDown:
      stabilizationWindowSeconds: 60
      policies:
      - type: Pods
        value: 2
        periodSeconds: 60
```

## The practice runbook — P0 to P5

The phases as practiced (verified green 2026-10-11); every command is
copy-paste. Do them in order — each phase builds on the last, and the
guide chapters map onto them: P0=§2–5 · P1=§6–7 · P2=§8–9,12–13 ·
P3=§10–11,15–16 · P4=§14 · P5=§18,23.

**P0 — Cluster & nodes.** Create the cluster; ~30s of NotReady is normal
(kindnet starting, §4). Nodes are Docker containers:

```console
$ kind create cluster --config .k8s/kind-cluster.yaml --name k8slab
$ kubectl get nodes -o wide
$ docker ps --filter label=io.x-k8s.kind.cluster=k8slab
```

**Images — build & load** (details and quirks in the build section
below):

```console
$ docker build -t k8slab/facts:v1    -f .docker/facts/Dockerfile    facts/
$ docker build -t k8slab/counter:v1  -f .docker/counter/Dockerfile  counter/
$ docker build -t k8slab/image:v1    -f .docker/image/Dockerfile    image/
$ docker build -t k8slab/loadgen:v1  -f .docker/loadgen/Dockerfile  loadgen/
$ docker build -t k8slab/frontend:v1 -f .docker/frontend/Dockerfile .
$ kind load docker-image k8slab/facts:v1 k8slab/counter:v1 k8slab/image:v1 \
    k8slab/loadgen:v1 k8slab/frontend:v1 --name k8slab
```

**P1 — Pods.** Namespace first, then the raw facts Pod; exercise the five
verbs (§6), then delete it and watch it stay gone:

```console
$ kubectl apply -f .k8s/manifests/00-namespace.yaml -f .k8s/manifests/01-facts-pod.yaml
$ kubectl get pods -n k8slab -o wide
$ kubectl describe pod facts-raw -n k8slab
$ kubectl logs -n k8slab facts-raw
$ kubectl -n k8slab exec -it facts-raw -- env | grep COUNTER
$ kubectl -n k8slab port-forward pod/facts-raw 8000:8000
$ kubectl delete -f .k8s/manifests/01-facts-pod.yaml
```

**P2 — Deployments & Services.** Apply the directory (30/40 dormant
until P4/P5; 01 may recreate the raw Pod — delete it). Self-heal, scale,
watch load balance in the logs:

```console
$ kubectl apply -f .k8s/manifests/
$ kubectl -n k8slab delete pod -l app.kubernetes.io/name=facts
$ kubectl get pods -n k8slab -w
$ kubectl -n k8slab scale deploy/facts --replicas=3
$ kubectl -n k8slab port-forward svc/frontend 8081:80
$ kubectl logs -n k8slab -l app.kubernetes.io/name=facts --prefix
```

(8081 avoids both ingress ports: this lab's 8090 mapping and the
github_actions lab's 8080.) Repeated dashboard clicks land on different
pod names in the `--prefix` logs — §12 made visible.

**P3 — Config & health.** Inspect the ConfigMap/Secret, then the two live
demos: the missing-ConfigMap error (§15) and the liveness kill (§10):

```console
$ kubectl -n k8slab exec deploy/facts -- env | grep COUNTER
$ kubectl -n k8slab delete configmap k8slab-config
$ kubectl -n k8slab rollout restart deploy/facts && kubectl -n k8slab get pods -w
$ kubectl apply -f .k8s/manifests/05-configmap.yaml     # recovery, no restart needed
$ kubectl -n k8slab exec deploy/counter -- kill 1
$ kubectl -n k8slab get pods -n k8slab -w               # RESTARTS +1, same pod
```

**P4 — Ingress.** Install ingress-nginx + the nodeSelector patch (the
gotcha, below), then the Ingress object itself:

```console
$ kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
$ kubectl -n ingress-nginx patch deploy ingress-nginx-controller \
    -p '{"spec":{"template":{"spec":{"nodeSelector":{"ingress-ready":"true"}}}}}'
$ kubectl apply -f .k8s/manifests/30-ingress.yaml
$ kubectl -n k8slab get ingress
$ curl -I http://localhost:8090/
```

**P5 — Autoscaling.** metrics-server + patch (§23 quoted why), then the
HPA, the load run, and the rollout finale:

```console
$ kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
$ kubectl patch deployment metrics-server -n kube-system --type='json' -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
$ kubectl -n k8slab apply -f .k8s/manifests/40-hpa.yaml
$ kubectl -n k8slab get hpa -w
```

In the dashboard (Load Simulator): duration **60s**, concurrency **20**,
Start Load — observed live: idle 3→1; under load 1→4→6 at ~252% CPU;
after stop, 6→4→2→1 over the stabilization window. Then:

```console
$ kubectl top pods -n k8slab
$ kubectl -n k8slab rollout history deploy/facts
$ kubectl -n k8slab rollout undo deploy/facts
```

## Images & the build side

Kubernetes runs images; it does not build them (§30). One Dockerfile per
service lives under `.docker/<service>/` — build files out of the code
dirs, so each service dir stays clean. The facts one shows the family
style (slim base, dependencies before code for layer caching, non-root
user):

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

(The others: `node:20-alpine` for counter/loadgen, a two-stage Go build
for image, stock nginx plus files for the frontend.)

**The kind gotcha.** Your docker daemon built these images — but the
cluster nodes are *separate containers with their own image caches*:
`k8slab/facts:v1` is invisible inside them, and a Pod referencing it
would sit in `ErrImagePull` (a public-registry image would simply pull —
hence `imagePullPolicy: IfNotPresent`). The fix is `kind load
docker-image … --name k8slab`, and the loop for any code change is
three lines:

```console
$ docker build -t k8slab/facts:v1 -f .docker/facts/Dockerfile facts/
$ kind load docker-image k8slab/facts:v1 --name k8slab
$ kubectl -n k8slab rollout restart deploy/facts
$ kubectl -n k8slab rollout status deploy/facts
```

**The frontend quirk — build from the repo root.** The frontend image
bakes in files from three places (`frontend/`, the repo-root `GUIDE.md`,
and a renderer downloaded at build time), so its context is `.` — any
other context fails loudly on the first COPY:

<!-- source: .docker/frontend/Dockerfile -->
```dockerfile
# Client-side markdown renderer, vendored at PINNED versions from jsdelivr at
# BUILD time only — no CDN at runtime, no vendored copies in the repo.
# sha256s pin the exact artifacts (supply-chain hygiene).
ARG MARKED_VERSION=12.0.2
ARG HIGHLIGHTJS_VERSION=11.11.1
```

Which means: **GUIDE.md is content of the image** — editing this file
changes nothing at runtime until the frontend image is rebuilt, loaded,
and redeployed. The page you are reading arrived via that exact pipeline.

## The Load Simulator and the simulated HPA

The dashboard's Load card is the loadgen's UI (POST `/api/load/start`,
poll `/api/load/status`). Its replica badge calls `/load/replicas`, and
that endpoint is honest about where it runs: **in this cluster** it reads
the facts Deployment's live replica count from the Kubernetes API — the
ServiceAccount + RBAC grant of §18 exists precisely for this; outside
Kubernetes (the same frontend runs as plain docker compose deployments)
there is no HPA, so the loadgen runs a *simulated* one, clearly labeled
`mode: "simulated-hpa"`: same shape as `40-hpa.yaml` — a smoothed
requests/sec signal, scale-up and scale-down thresholds with a hysteresis
gap, min/max bounds of 1–6, a cooldown — but simulated from its own
traffic, no cluster involved. The design rule it enforces: a dashboard
must never fake being the real thing silently.

## Teardown

```console
$ kind delete cluster --name k8slab
```

Everything — nodes, Pods, loaded images, the kubeconfig context — is
gone. The lab is designed to be re-created from scratch in minutes:
P0, build/load images, P1 onward. Infrastructure as files, not as pets.

## The gotchas, collected

Every one of these was hit live; each is documented at its source too.

1. **~30s `NotReady` after `kind create cluster`** — kindnet (the CNI)
   is still starting; no alarm, no Pods schedule until it's up (§4).
2. **`ErrImagePull` for `k8slab/*` images** — nodes have their own image
   caches; `kind load docker-image …` after every build, or the deploy
   can't see the image (§ "Images & the build side").
3. **Frontend builds from the REPO ROOT** (`-f .docker/frontend/Dockerfile .`)
   — it bakes `frontend/` + `GUIDE.md` + renderer; other contexts fail.
   And GUIDE.md is image content: edit → rebuild → load → redeploy.
4. **ingress-nginx nodeSelector patch is mandatory** — the upstream kind
   manifest no longer pins the controller to the `ingress-ready` node;
   without the patch it can land on a worker, where nothing maps host
   port 8090, and `localhost:8090` stays dark. The patch (P4) restores
   the classic placement (§14, §24).
5. **Port 8090, not 8080** — the sibling github_actions lab's cluster
   holds 8080 when both run together; this lab moved permanently.
   port-forward uses 8081 to avoid both.
6. **metrics-server needs `--kubelet-insecure-tls` on kind** —
   self-signed kubelet certs fail default verification; without
   metrics-server at all, the HPA shows `<unknown>` and never scales
   (§23).
7. **Deleting a ConfigMap mid-deploy** sticks new Pods in
   `CreateContainerConfigError` until re-applied — loud by design (§15).
8. **port-forward binds one specific Pod** — after a frontend rollout,
   re-run it; and killing the tunnel kills every dashboard tab at once
   while the cluster is perfectly healthy (§29). The Ingress (P4) is the
   fix.
9. **Applying the whole manifests dir re-creates `01-facts-pod.yaml`** —
   the raw P1 Pod returns; delete it again (it's deliberately labeled
   `facts-raw` so it can never collide with the facts Service, §7).

Happy clustering — when in doubt, `kubectl describe` the thing.
