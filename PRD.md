# pollinate PRD

> **Status, 2026-11-25.** This is the original product requirements document.
> §1–§8 (except §7.5 and §7.6) and §10–§19 are history: they record the design
> intent and are kept only as background; on 2026-11-25 their references to
> removed Honeybee features were replaced or marked. §7.5, §7.6, §9, §13 and §14
> were rewritten that day to describe Pollinate as it is today, using the hive
> v2 grammar. For current
> behaviour read [AGENTS.md](AGENTS.md) (the operating contract) and
> [README.md](README.md); where this document disagrees with them, they win.
> Pollinate no longer has honeybee `run = "buz" | "comb" | "flow" | "loop"`,
> the `hermes` action, or `pol sidebar`; `pol add` refuses the removed kinds
> and names the replacement.

## 1. Summary

**pollinate** is a standalone **trigger substrate**: a small, always-on, dumb-but-reliable
daemon that converts *time, events, and webhooks* into *fired actions*. It is the layer
that decides **when** something runs — and nothing more.

Pollination is triggered activity that makes the garden produce: bees moving between
flowers is the event that causes fruiting. pollinate is the system whose firings make
downstream systems produce. It sits **upstream** of both honeybee (which executes bees)
and Hermes (which reasons/orchestrates), and it drives them as targets.

pollinate **never reasons** (that is Hermes) and **never runs agents itself** (that is
honeybee). It ingests triggers, applies delivery policy, resolves context, and invokes an
action against a target. That narrow job is what makes it orthogonal and reusable.

## 2. Motivation

Triggering logic — "every morning at 08:00", "when a run seals", "on this webhook",
"poll this source every 5 minutes" — currently has no home. It ends up trapped inside
individual agents/systems, where it is invisible, non-reusable, and inconsistent.

- honeybee runs bees: durable sessions that work while they have mail. It does not
  cover *discrete activation*: scheduled, event-driven, or webhook-driven spawning of
  fresh bees or messages to existing ones.
- honeybee deliberately refuses to grow a scheduler ("no hidden autonomous background
  work" is its anti-goal). It stays the executor.
- Hermes has its own internal scheduling for its own jobs, which is fine — but that is
  self-scheduling, not a shared trigger plane for the whole system.

pollinate extracts the trigger concern into one observable, restart-safe service that
everything can use, drawing its design from HJUL (Valhall's now-deprecated scheduling
subsystem) but provider-agnostic and free of Valhall's NATS/gRPC mesh.

## 3. Goals

- One always-on daemon that turns **schedules**, **event-polls**, and **webhooks** into
  fired actions.
- **Delivery policy** that plain cron lacks: immediate / throttled / batched / debounced,
  with per-trigger concurrency caps and queueing.
- **Generic action targets**: honeybee (`hive spawn` / `hive send` / `hive stop`),
  arbitrary shell command (which can call Hermes), outbound HTTP, or an internal emit
  (for chaining). pollinate is execution-agnostic.
- **Context resolver**: gather state from pluggable sources before firing and inject it
  into the action via simple `{{var}}` templating.
- **Restart-safe**: persisted schedule clocks, delivery timers, pending batches, and poll
  cursors. No silent double-fires or missed fires across restarts.
- **Observable**: job tracking, status, its own event ledger, dry-run everywhere.
- Be drivable from a human shell, from honeybee/Hermes, and from CI/automation.

## 4. Non-goals

- **No reasoning / judgment / planning.** That is Hermes. pollinate fires; it does not
  decide what *should* be done.
- **No agent execution.** pollinate never spawns a bee in-process; it invokes honeybee.
- **No resident agent work.** A bee that keeps working stays in honeybee. pollinate owns
  discrete activation. (See §8.)
- **Does not absorb or replace Hermes's internal cron.** Hermes self-schedules its own
  work; pollinate is an opt-in shared plane with a delegation seam. (See §8.)
- **No mesh / multi-node** in v1. Single node.
- **No complex transforms / scripting** in templating. `{{var}}` substitution only.
- **No outbound webhook delivery as a first-class concept** beyond the generic `http`
  action.
- **No UI** in v1. CLI + on-disk config + (optional) local HTTP API.

## 5. Primary Users

### Tormod / humans
Register a schedule, a webhook, or a poll once and forget it; inspect what fired and why.

### honeybee / Hermes / automation
A trigger fires `hive spawn …` / `hive send …`, or runs a command (which can call
Hermes). Hermes can also *register* triggers in pollinate when it wants the shared,
observable plane rather than its own internal cron.

## 6. Position in the Stack

```text
            ┌──────────────────────────────────────────────────────────┐
 pollinate  │ INGRESS: schedules · event-polls · webhooks               │
 (trigger   │   → normalize → filter → DELIVERY (immediate/throttle/    │
  substrate)│     batch/debounce) → resolve CONTEXT → fire ACTION       │
            └───────────────┬───────────────────────────┬──────────────┘
                            │ fires an action            │
                   ┌────────▼────────┐          ┌────────▼─────────┐
                   │ honeybee        │          │ Hermes           │
                   │ spawn/send/stop │          │ reason / decide  │   (+ command / http / emit)
                   └─────────────────┘          └──────────────────┘
```

- **pollinate** = WHEN/WHAT-FIRES. Dumb, reliable, always-on.
- **honeybee** = EXECUTE (run the bees). pollinate's most common target.
- **Hermes** = REASON/ORCHESTRATE. pollinate can fire Hermes; Hermes can register triggers
  in pollinate. Their internals are not touched.

## 7. Core Concepts

### 7.1 Trigger

The unifying abstraction. A **trigger** is a named binding of:

```
trigger = source + filter? + delivery + context? + action
```

```ts
type Trigger = {
  id: string;                 // unique, used in URLs/CLI
  name: string;
  description?: string;
  cwd?: string;                // default working directory for command-backed work
  tags: string[];
  enabled: boolean;
  source: Source;             // what activates it
  filter?: Filter;            // which activations count
  delivery: Delivery;         // how activations map to action fires
  context?: ContextResolver;  // state gathered before firing
  action: Action;             // what to fire
  createdAt: string; updatedAt: string;
};
```

`cwd` is a trigger-level default. Command poll fetches, command context sources,
command actions, and Honeybee actions inherit it unless they define a
more specific `cwd`. Jobs snapshot the trigger `cwd` when queued so later trigger
edits do not move already queued work.

### 7.2 Source — what activates the trigger

```ts
type Source =
  | { kind: "schedule"; timing: ScheduleTiming }
  | { kind: "poll";     poll: PollSpec }
  | { kind: "webhook";  webhook: WebhookSpec }
  | { kind: "manual" };       // only fired by `pollinate trigger <id>`

type ScheduleTiming =
  | { type: "cron";  expression: string; timezone: string } // "0 8 * * 1-5"
  | { type: "every"; interval: string }                      // "5m", "2h"
  | { type: "once";  at: string };                           // ISO; disables after firing
```

**Poll source** — pull a source on an interval, diff against a persisted cursor, emit a
trigger event per new item:

```ts
type PollSpec = {
  interval: string;                  // "30s", "5m"
  // How to fetch the current state:
  fetch:
    | { kind: "command"; command: string; cwd?: string }   // stdout (JSON lines or text)
    | { kind: "http"; method: string; url: string; headers?: Record<string,string> }
    | { kind: "file"; path: string };                       // re-read on change
  // How to detect "new":
  cursor: { strategy: "append-offset" | "hash" | "jsonpath"; jsonpath?: string };
  // Emit one trigger event per new item, or one per poll with the full delta:
  emit: "per-item" | "per-poll";
};
```

The **poll source is the honeybee event bridge**: a poll over `hive seal list --json` /
`hive events --json` / `hive list --json` turns honeybee's pull-only, file-based events into
triggers — no push bus, no NATS, no honeybee changes. (See §13.)

**Webhook source** — an HTTP endpoint that becomes a trigger:

```ts
type WebhookSpec = {
  path: string;                 // served at /hook/<path>
  secret?: string;              // HMAC validation (sha256)
  transform?: Record<string,string>; // jsonpath field map applied to the body
};
```

### 7.3 Filter

Simple equality / existence checks against the activation payload, evaluated before
delivery. `{ "status": "done", "agent": "claude" }` → only fire for matching events.

### 7.4 Delivery — how activations map to fires (the gem)

```ts
type Delivery = {
  mode: DeliveryMode;
  maxConcurrent: number;   // cap concurrent action instances; excess queues (FIFO)
};

type DeliveryMode =
  | { strategy: "immediate" }                                  // 1 activation → 1 fire
  | { strategy: "throttled"; interval: string; collect: boolean } // fire, then cooldown
  | { strategy: "batched";   window: string; maxBatch: number }   // collect window → 1 fire
  | { strategy: "debounced"; quietPeriod: string };               // fire after silence
```

`collect`/`batched`/`debounced` accumulate activation payloads and expose them to the
action as `{{batch}}` / `{{batch_count}}`. Schedules are effectively `immediate`;
`maxConcurrent: 1` is the "skip if previous still running" guard.

### 7.5 Action — what fires

```ts
type Action =
  | { kind: "honeybee"; run: "spawn"; bee: string; name?: string; colony?: string;
      home?: string; cwd?: string; yolo?: boolean; args?: string[]; message?: string; timeout?: string }
  | { kind: "honeybee"; run: "send"; target: string; message: string; timeout?: string }
  | { kind: "honeybee"; run: "kill"; target: string; timeout?: string }
  | { kind: "command";  command: string; cwd?: string; timeout?: string }
  | { kind: "http";     method: string; url: string; headers?: Record<string,string>; body?: string; timeout?: string }
  | { kind: "emit";     subject: string; payload?: string }  // internal event for chaining
  | { kind: "sequence"; mode?: "serial" | "parallel"; primary?: string; continueOnError?: boolean;
      actions: { id?: string; action: Action }[] };
```

Everything templates through `{{var}}`. honeybee actions run `hive` argv-style, never
through a shell, in the hive v2 grammar:

- `spawn` → `hive spawn <name> --agent <bee> --json [--cwd <cwd>] [--tag colony=<colony>]
  [--account <home>] [--arg <value>]…`, then `hive send <handle> <message>` when
  `message` is set.
- `send` → `hive send <target> <message>`.
- `kill` → `hive stop <target>` (the bee stays revivable; Pollinate never deletes bees).

A `hermes` action and honeybee `run = "buz" | "comb" | "flow" | "loop"` existed earlier
and were removed on 2026-11-25. Use a `command` action that runs hermes, `run = "send"`
for buz, and a scheduled `run = "spawn"` or `run = "send"` for comb, flow and loop.

### 7.6 Context Resolver

Gather state before firing; inject as template vars. Provider-agnostic — sources are
pluggable, resolved **in parallel** with a per-resolver timeout (proceed on partial
failure, warn, never block):

```ts
type ContextResolver = {
  sources: Array<
    | { var: string; kind: "command"; command: string; cwd?: string }   // stdout → var
    | { var: string; kind: "http"; url: string; jsonpath?: string }
    | { var: string; kind: "file"; path: string }
    | { var: string; kind: "honeybee"; query: string; timeout?: string } // hive read argv, e.g. "seal list --json"
  >;
  static?: Record<string, string>;
};
```

**Auto-injected vars:** `{{trigger_id}}`, `{{fired_at}}` (ISO), `{{source_kind}}`,
`{{event}}` (raw activation payload JSON), `{{batch}}`, `{{batch_count}}`. Unresolved
`{{vars}}` are left literal and logged as a warning, not an error.

### 7.7 Job

One execution of a trigger's action.

```ts
type Job = {
  id: string;
  triggerId: string;
  source: "schedule" | "poll" | "webhook" | "manual";
  status: "queued" | "resolving-context" | "running" | "completed" | "errored" | "timed-out";
  cwd?: string;                              // snapshotted from trigger at queue time
  context: Record<string,string>;          // resolved vars injected
  action: Action;                           // rendered
  result?: unknown;                         // exit code / handle / response
  error?: string;
  queuedAt: string; startedAt?: string; completedAt?: string;
};
```

## 8. The Two Boundaries (the conceptual crux)

### 8.1 pollinate vs honeybee

| "over and over" | owner | shape |
|---|---|---|
| a bee that keeps working while it has mail | **honeybee** | one durable session |
| discrete activation (cron/interval/event/webhook) | **pollinate** | N separate fires: spawn a bee or send one a message |

They compose: a pollinate schedule can spawn a bee every night, or send the next task
to a long-lived one; a webhook can spawn a one-shot reviewer.

### 8.2 pollinate vs Hermes self-scheduling

- **Self-scheduling** (a system recurring its *own internal* work, e.g. Hermes's internal
  cron) stays where it is. Not everything routes through pollinate, and Hermes internals
  are **not** touched.
- **pollinate** is the *shared, observable* plane for triggers that are cross-system /
  external-facing / need delivery policy / need to be centrally managed.
- **Delegation seam:** Hermes can register a trigger in pollinate (CLI/API) whose action
  is a `command` that calls Hermes — pollinate fires back into Hermes. "Both" coexist precisely
  because of this boundary. Hermes opts in per-trigger; reversible.

## 9. CLI Surface

Binary `pollinate` (alias `pol`). All commands support `--json`. `pol --help` and
AGENTS.md → "CLI map" are the full reference.

```
# Triggers
pollinate add <config.toml>              # register a trigger from file
pollinate create <id> …                  # build a trigger from flags (see pol --help)
pollinate list [--enabled|--disabled] [--tag <t>] [--source schedule|poll|webhook|manual]
pollinate get <id>
pollinate enable <id> | disable <id> | remove <id>
pollinate edit <id>                      # open the config; validated on editor exit

# Manual fire / testing
pollinate trigger <id> [--payload '{"k":"v"}']   # fire now, ignore timing/source
pollinate trigger <id> --dry-run                 # resolve context + render action, do NOT run

# Jobs
pollinate jobs [--status running|queued|completed|errored] [--trigger <id>] [--last <n>]
pollinate jobs gc [--max-age 14d] [--keep-last 50] [--dry-run]
pollinate job <jobId>
pollinate job cancel <jobId>

# Job IDs
# Visible IDs are <trigger-prefix>.<uuid-prefix>, e.g. HE.a3f. The suffix is the
# shortest globally unused backing-UUID prefix, never shorter than three chars,
# and state/job-id-index.json prevents suffix reuse across historical jobs.

# Webhooks and routers
pollinate hooks                          # list webhook routes + secrets-configured
pollinate hook create|inbox|wait|gc      # temporary webhooks
pollinate hook test <id> --payload '{...}'
pollinate bindings [--trigger <id>] | bindings get <id>
pollinate routers [list] | routers init <name>
pollinate github create-pr-router <id> | github install-pr-router <id>
pollinate satellite run --target <url> --secret <secret>

# Daemon
pollinate daemon install | uninstall | start | stop | restart | status | logs
pollinate daemon run --foreground        # used by the service manager

# System
pollinate status                         # active triggers, running/queued jobs, next fires
pollinate ledger [-n <lines>] [--follow]
pollinate --version [--json]
```

### 9.1 Config format (TOML, one file per trigger)

```toml
# ~/.pollinate/triggers/morning-audit.toml — spawn a bee every weekday morning
[trigger]
name = "morning-audit"
description = "Weekday repo audit"
tags = ["audit", "daily"]
enabled = true

[trigger.source]
kind = "schedule"
[trigger.source.timing]
type = "cron"
expression = "0 6 * * 1-5"
timezone = "Europe/Oslo"

[trigger.delivery]
mode = "immediate"
maxConcurrent = 1                # skip if the previous fire is still going

[trigger.action]
kind = "honeybee"
run = "spawn"
bee = "claude"
cwd = "/Users/trmd/Projects/trmd/honeybee/repos/honeybee"
message = "Pick the next TODO in src, resolve it, and seal what you did."
```

```toml
# ~/.pollinate/triggers/on-seal-review.toml — poll honeybee seals, debounce, then review
[trigger]
name = "review-new-seals"
tags = ["review"]
enabled = true

[trigger.source]
kind = "poll"
[trigger.source.poll]
interval = "30s"
emit = "per-item"
[trigger.source.poll.fetch]
kind = "command"
command = "hive seal list --json"
[trigger.source.poll.cursor]
strategy = "jsonpath"
jsonpath = "$.seals[*].id"

[trigger.delivery]
mode = "debounced"
quietPeriod = "2m"
maxConcurrent = 1

[trigger.action]
kind = "honeybee"
run = "send"
target = "seal-reviewer"
message = "New seals to review:\n{{batch}}"
```

```toml
# ~/.pollinate/triggers/telegram-in.toml — webhook → message a bee
[trigger]
name = "telegram-inbound"
enabled = true

[trigger.source]
kind = "webhook"
[trigger.source.webhook]
path = "telegram"
secret = "env:POLLINATE_TELEGRAM_SECRET"
[trigger.source.webhook.transform]
text = "$.message.text"
chat_id = "$.message.chat.id"

[trigger.delivery]
mode = "immediate"
maxConcurrent = 4

[trigger.action]
kind = "honeybee"
run = "send"
target = "telegram-desk"
message = "Telegram message: {{event}}"   # event is the transformed payload as JSON
```

## 10. On-disk Layout / Persistence

Rooted at `POLLINATE_STORE_ROOT` (default `~/.pollinate/`), mirroring honeybee's
`HIVE_STORE_ROOT` convention. Atomic writes, `0600`.

```
~/.pollinate/
├── pollinate.toml              # daemon config (webhook port/bind, defaults, store paths)
├── triggers/<id>.toml          # one file per trigger (canonical source)
├── state/
│   ├── schedule-state.json     # last-fire / next-fire per schedule
│   ├── delivery-state.json     # throttle/debounce timers, pending batches
│   └── cursors.json            # poll cursors (last-seen offsets/hashes/ids)
├── jobs/                       # job history (rolling window, configurable retention)
└── ledger.jsonl                # pollinate's own event ledger (rotated)
```

On startup the daemon restores schedule clocks, delivery timers, pending batches, and
poll cursors from `state/` so it resumes exactly where it left off.

## 11. Daemon Architecture

```
pollinated
├── ScheduleEngine     — cron + interval + once → Dispatcher
├── PollEngine         — runs PollSpecs on interval, diffs vs cursor → Dispatcher
├── WebhookServer      — HTTP listener, HMAC validation, transform → Dispatcher
├── DeliveryManager    — immediate / throttled / batched / debounced + concurrency/queue
├── ContextResolver    — parallel resolution of context sources (timeout, partial-ok)
├── Dispatcher / ActionExecutor — render templates, invoke honeybee/command/http/emit/sequence
├── StateManager       — persist schedule/delivery/cursor state on every change
└── LedgerEmitter      — append pollinate.* events
```

### Missed-fire policy
For schedules whose fire time elapsed while the daemon was down (sleep/wake, restart),
each schedule declares a policy: `skip` (default), `fire-once` (single catch-up), or
`fire-all` (every missed slot). Logged on catch-up.

## 12. Events Emitted (its own ledger)

History: the planned core set. The current list is AGENTS.md → "Ledger events".

```
pollinate.schedule.fired     { trigger_id, job_id, at }
pollinate.poll.detected      { trigger_id, job_id, item_count, at }
pollinate.webhook.received   { trigger_id, path, source_ip, at }
pollinate.job.queued         { job_id, trigger_id, queue_position, at }
pollinate.job.started        { job_id, trigger_id, action_kind, at }
pollinate.job.completed      { job_id, duration_ms, at }
pollinate.job.errored        { job_id, error, at }
```

These are themselves poll-able / emit-chainable (trigger A's `emit` action → trigger B's
poll/filter), enabling "A then B" without a hardcoded DAG.

## 13. honeybee Integration

- **As a target:** `honeybee` actions run `hive` argv-style in the v2 grammar:
  `run = "spawn"` → `hive spawn <name> --agent <bee> --json …` (plus `hive send` for
  `message`), `run = "send"` → `hive send <target> <message>`, `run = "kill"` →
  `hive stop <target>`. Router triggers use the spawn handle as the binding target and
  default `onClose` to `kill`. Every call retries while Honeybee reports
  `daemon_starting` (AGENTS.md → "Honeybee starting window").
- **As an event source:** a `poll` source over hive reads with a persisted cursor turns
  honeybee events into triggers, for example `hive seal list --json` with
  `jsonpath = "$.seals[*].id"`, `hive events --json` with `jsonpath = "$.rows[*].seq"`,
  or `hive list --json`. honeybee stays pull-only; pollinate does the polling.
- **As a context source:** `kind = "honeybee"` runs one hive read before the action, with
  `query` as its argv without the leading `hive`, for example `query = "seal list --json"`,
  `query = "view {{bee}} --json"`, `query = "mailbox {{bee}} --unread --json"` or
  `query = "last {{bee}}"`.
- **Not used:** Honeybee v2 has no flows, loops, combs, tracks, tmux sessions or
  `hive search`, and `hive buz` is a v1 compatibility alias for `hive send`. Pollinate
  uses none of them.

## 14. Hermes Integration

- **Leave Hermes internals alone.** Hermes keeps its own internal cron for its own jobs.
- **pollinate → Hermes:** a `command` action runs the Hermes CLI. There is no dedicated
  Hermes action; one existed and was removed on 2026-11-25, and `pol add` refuses it.
- **Hermes → pollinate:** Hermes can register/enable/disable triggers via the `pollinate`
  CLI when it wants the shared, observable plane. Opt-in per trigger.

## 15. Safety / Operating Defaults

- **Dumb activator.** No reasoning, no in-process agent execution — fires actions only.
- **Restart-safe & idempotent.** Persisted clocks/timers/cursors; explicit missed-fire
  policy; no silent double-fire or skipped fire across restarts.
- **Concurrency caps.** Per-trigger `maxConcurrent`; excess queues FIFO. A saturated
  trigger never stampedes its target.
- **Webhook security.** HMAC validation when a secret is set; reject bad signatures with
  403; respond within 2s and process async; bind `127.0.0.1` by default (Tailnet/loopback
  for exposure).
- **Dry-run + manual fire** for every trigger before arming it.
- **Secrets** referenced as `env:NAME`, never persisted in plaintext config or logged.
- **Single node** in v1; no distribution.

## 16. Implementation Notes (recommended)

- **Language/runtime:** TypeScript on Node ≥20, matching honeybee — ergonomic CLI, trivial
  child-process invocation of `hive`, fast iteration, shared aesthetic/store conventions.
  (Rust is the alternative if a hardened long-running daemon is preferred; see Open
  Questions.)
- **Service manager:** launchd LaunchAgent on macOS, systemd `--user` unit snippet on
  Linux — mirror honeybee's `hive daemon install` exactly.
- **Deps (TS path):** a cron parser, a tiny HTTP server (webhooks) — Node `http` is
  enough, `hmac`/`crypto` builtin, `jsonpath` for transforms/cursors, TOML parser,
  atomic-write + file-lock helpers (port honeybee's `fsx`).
- **Store conventions:** `POLLINATE_STORE_ROOT`, atomic writes, `0600`, ENOENT→null
  readers, append-only ledger with rotation — all ported from honeybee.

## 17. Milestones

- **v0 (core):** trigger registry + config load; ScheduleEngine (cron/every/once);
  Dispatcher with `command` + `honeybee` actions; job tracking; daemon install/run;
  `pollinate add/list/get/trigger --dry-run/jobs/status`. State persistence + missed-fire.
- **v1 (the value):** WebhookServer (HMAC, transform); `http`/`emit` actions (and a
  `hermes` action, removed 2026-11-25);
  full DeliveryManager (immediate/throttled/batched/debounced + concurrency/queue);
  context resolver (parallel, partial-ok).
- **v2 (events):** PollEngine + cursors (honeybee ledger/seals bridge); `emit`-based
  chaining; `--follow` ledger.
- **later:** multi-node, richer transforms, a UI/TUI, optional honeybee `hive events` push
  seam.

## 18. Acceptance Criteria

- A cron schedule fires its action at the right time; `every` fires on interval; `once`
  fires then disables.
- A webhook with a valid HMAC fires its action; an invalid signature is rejected 403; the
  endpoint responds < 2s.
- A poll source detects only *new* items (cursor advances; restart does not re-fire seen
  items) and fires per `emit` mode.
- Each delivery mode behaves: immediate 1:1; throttled cools down (and optionally collects);
  batched fires once per window/`maxBatch`; debounced fires after `quietPeriod`. `{{batch}}`
  is populated.
- `maxConcurrent` caps concurrent fires; excess queues and drains FIFO.
- The context resolver injects vars, runs sources in parallel, and proceeds on partial
  failure with a warning.
- `honeybee` actions successfully run `hive spawn` / `hive send` / `hive stop`;
  `command`/`http` work; `dry-run` renders without executing.
- The daemon survives restart: schedule clocks, delivery timers, pending batches, and poll
  cursors are restored from `state/`; the missed-fire policy is honored.
- `pollinate status` / `jobs` / `ledger` reflect reality; `pollinate.*` events are emitted.

## 19. Open Questions

- **Language/runtime:** TypeScript/Node (recommended, honeybee-consistent) vs Rust
  (hardened daemon, closer to HJUL). Decide before v0.
- **Binary/alias name:** `pollinate` + `pol`? Any bee-flavored subcommand vocabulary
  (`pollinate bloom`/`pollinate scout`), or keep literal (`schedule`/`poll`/`webhook`)?
- **Hermes seam:** resolved. Pollinate calls Hermes through a `command` action; Hermes
  registers triggers through the `pollinate` CLI.
- **Chaining bus:** keep `emit` events internal (poll-the-ledger) for v2, or expose a
  lightweight subscribe API later?
- **Schedule engine:** own cron evaluator vs lean on system cron/systemd timers for pure
  schedules (and keep pollinate focused on poll/webhook/delivery)? Trade-off: one system &
  observability vs less code.
- **Repo home:** confirmed standalone in `trmd` family (this path). Sibling to honeybee,
  shared store/aesthetic conventions, independent release.

---

**Prior art / references**
- HJUL MVP spec (design reference; Valhall, deprecated):
  `/Users/trmd/Projects/trmd/valhall/repos/valhall/docs/9004-hjul-mvp.md`
- honeybee (the primary executor target): `/Users/trmd/Projects/trmd/honeybee/repos/honeybee`
  — entrypoints `hive spawn` / `hive send` / `hive stop`; the v2 CLI is
  `v2/cli/src/main.ts`.
