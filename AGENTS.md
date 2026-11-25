# AGENTS.md — operating pollinate

Pollinate is a standalone trigger substrate: schedules, polls, and webhooks fire
configured actions (shell commands, HTTP calls, hive/honeybee agent operations).
A router binds long-lived subjects (e.g. a GitHub PR) to long-lived agent
sessions. This file is the operating contract for agents driving pollinate —
everything here is otherwise only discoverable by reading the source.

## Quick facts

- Binaries: `pollinate` and `pol` (identical). Source of truth: `src/cli.ts`.
- Store root: `~/.pollinate`, overridable with `POLLINATE_STORE_ROOT`.
- Add `--json` to any command for machine-readable output. Errors with `--json`
  print `{"error": "..."}` to stderr and exit 1.
- Dev loop: `pnpm build` (tsc, then `scripts/write-build-info.mjs`), `pnpm test`
  (build + vitest), `pnpm check` (build + test typecheck + lint + test).
- `pol --version` (or `-V`) prints `pollinate <version> (<12-char commit>)`, with
  ` dirty` after the commit for a dirty build and `(unknown commit)` when there
  is no build info. `pol --version --json` prints the build info object (see
  Build info) and always exits 0.
- `pol add <file.toml>` and `pol create <id>` **overwrite** an existing trigger
  with the same id silently — check `pol get <id>` first if that matters.
- `--dry-run` exists on `pol trigger`, `pol github …`, and `pol jobs gc`.

## Build info

`pnpm build` runs `tsc`, then `scripts/write-build-info.mjs`, which writes
`dist/build-info.json`. It ships in the npm package with the rest of `dist/`.

```json
{"name":"pollinate","version":"1.0.0","commit":"<40-hex sha>","dirty":false,"builtAt":"2026-11-25T12:00:00.000Z"}
```

- `commit` comes from `POLLINATE_BUILD_COMMIT` when set (release builds set it;
  it must be a 40-character hex sha or the build fails), else from
  `git rev-parse HEAD` when the package root is the top of its own git checkout.
- `dirty` is `git status --porcelain` non-empty. It is `null` when the commit
  came from `POLLINATE_BUILD_COMMIT` or git is unavailable.
- With no env var and no git, `commit` and `dirty` are `null` and the build
  still succeeds.
- `pol --version [--json]` reads the file next to `dist/cli.js` (symlinked bins
  resolve to the real file). When the file is missing, `--json` reports
  `commit`, `dirty` and `builtAt` as `null` and the version from `package.json`.

## Releases

Every green push to `main` is published as GitHub release `runtime-<sha>`
(title `Pollinate runtime <sha8>`, target the sha) by
`.github/workflows/release.yml`. It runs after workflow `CI` succeeds for a
push to `main`, or by hand: `gh workflow run release.yml -f sha=<40-hex sha>`
(refused unless the sha is a full lowercase sha on `main`). Assets:

- `pollinate-<sha>.tgz`: `pnpm pack` output; every entry under `package/`,
  including `package/dist/cli.js` and `package/dist/build-info.json`. Apiary pins
  this file by sha256 and stages it; keep the layout.
- `pollinate-<sha>-standalone.tgz`: one directory `pollinate-<sha>/` with the
  packed package plus production-only `node_modules` installed from
  `pnpm-lock.yaml` (hoisted, no dev dependencies, no absolute symlinks), so
  `node pollinate-<sha>/dist/cli.js` runs with only `node`.
- `SHA256SUMS`: `shasum -a 256` of both tarballs; check with
  `shasum -a 256 -c SHA256SUMS`.

Releases are immutable by rule: if `runtime-<sha>` exists the job exits green
without touching it, and nothing deletes, overwrites or re-uploads an asset. A
draft `runtime-<sha>` (a failed upload) fails the job for a human to inspect.
The release is marked latest only when the sha is the tip of `main`.

Both paths run `scripts/release-runtime.sh [--out <dir>] [--publish] [<sha>]`
(default sha: the tip of `origin/main`, default out
`$TMPDIR/pollinate-runtime-<sha>`). It builds the sha from `git archive` with
`POLLINATE_BUILD_COMMIT=<sha>`, packs, builds the standalone tree
(`scripts/check-standalone.mjs` checks it), writes `SHA256SUMS`, and runs
`scripts/smoke-runtime.mjs <standalone.tgz> <sha>`: unpack into a fresh temp
dir, `--version --json` must report the sha, start `daemon run --foreground`
on a temp store with a free webhook port, add a webhook trigger whose `command`
action writes a marker, POST to it, wait for the job to complete and the
marker, stop the daemon by pid. Without `--publish` it only builds locally.

## Running a release (personal daemon)

On Tormod's Mac the launchd daemon `dev.pollinate.pollinated` and
`/opt/homebrew/bin/{pol,pollinate}` run `~/.local/share/pollinate/current/dist/cli.js`,
not a checkout, so `pnpm build` in a checkout changes nothing that runs.

`node scripts/install-runtime.mjs [<sha> | latest] [--root <dir>] [--launchd] [--bin <dir>]`
(Node standard library only, run from any checkout):

- `latest` is the newest non-draft `runtime-*` release (by `created_at`) that
  has `pollinate-<sha>-standalone.tgz`. Uses `GITHUB_TOKEN` or `gh auth token`
  when available.
- Downloads the standalone tarball and `SHA256SUMS`, checks the sha256, refuses
  entries outside `pollinate-<sha>/` or containing `..` and symlinks leaving the
  tree, unpacks into a temp dir under the root, requires `--version --json` to
  report `<sha>`, then renames it to `<root>/<sha>/` (default root
  `~/.local/share/pollinate`).
- Repoints `<root>/current` to the relative target `<sha>` atomically and prints
  the previous target. A sha that is already installed is not downloaded again.
  Installed versions are never deleted.
- `--launchd` rewrites `~/Library/LaunchAgents/dev.pollinate.pollinated.plist`
  to run `<root>/current/dist/cli.js` (the unresolved path), keeping its node,
  environment and log paths, after copying the old plist to
  `<root>/rollback/dev.pollinate.pollinated.plist.<UTC stamp>`. It restarts
  nothing. Don't use `pol daemon install` for this: it writes the resolved
  `<sha>` path.
- `--bin /opt/homebrew/bin` points `pol` and `pollinate` there at
  `<root>/current/dist/cli.js` and writes the old targets to
  `<root>/rollback/bin-links.<UTC stamp>.sh`.

Upgrade: `node scripts/install-runtime.mjs latest && pol daemon restart`.

Version rollback: repoint `current` to an earlier installed sha and restart,
`ln -sfn <sha> ~/.local/share/pollinate/current && pol daemon restart` (or
`node scripts/install-runtime.mjs <sha> && pol daemon restart`).

Full rollback to the checkout: copy the newest
`~/.local/share/pollinate/rollback/dev.pollinate.pollinated.plist.*` back to
`~/Library/LaunchAgents/dev.pollinate.pollinated.plist`, run
`sh ~/.local/share/pollinate/rollback/bin-links.*.sh` to restore the old
symlinks, then
`launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/dev.pollinate.pollinated.plist; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.pollinate.pollinated.plist`.

## Store layout

```text
~/.pollinate/
  triggers/<id>.toml              one trigger per file (0600)
  router-plugins/<name>.mjs       user-space router plugins
  state/schedule-state.json       next/last fire times
  state/delivery-state.json       throttle/batch/debounce queues, in-flight jobs, admissions (see Retry)
  state/deliveries-seen.json      stable delivery ids already fired (dedup; see Delivery identity)
  state/cursors.json              poll cursors
  state/job-id-index.json         UUIDs used for visible job ID suffixes
  state/job-id-index.lock         lock for the job ID index
  state/jobs-store.json           last retention sweep: job file count, bytes, largest triggers, warnings
  state/daemon-runs.json          last 20 daemon starts/clean stops (crash-loop detection)
  state/daemon.lock               one daemon per store: pid, start time, token; mtime is the heartbeat
  state/trigger-locks/<id>.lock   per-trigger write locks
  state/job-locks/<jobId>.lock    per-job write locks
  state/router-bindings/<trigger>/<subject>.json   binding records
  state/router-bindings/<trigger>/<subject>.lock   binding write locks
  jobs/<jobId>.json               one job per execution
  ledger.jsonl                    append-only event log (the source of truth)
  ledger.jsonl.1                  previous ledger generation (size-based rotation, see Job retention)
  daemon.log                      daemon lifecycle + GC log (pol daemon logs)
  daemon.out.log                  macOS launchd stdout log
  daemon.err.log                  macOS launchd stderr log
  pollinate.toml                  daemon config
```

## CLI map

| Command | Purpose |
|---|---|
| `pol add / create / list / get / enable / disable / edit / remove` | trigger CRUD; `edit` validates the TOML on editor exit |
| `pol trigger <id> [--payload '{…}'] [--delivery-id <id>] [--dry-run]` | fire manually; a repeated `--delivery-id` answers `duplicate` and does not fire |
| `pol jobs [--last 100] / job <id> / job cancel <id>` | job inspection; `pol jobs` lists the newest 100 unless `--last <n>` (n ≥ 1; `--last 0` is refused) says otherwise, and says so (stderr with `--json`) when more exist |
| `pol jobs gc [--max-age 14d] [--keep-last 50] [--max-per-trigger 500] [--max-total 20000] [--dry-run]` | remove terminal job files by age and by the per-trigger and total caps; unset flags come from `[retention]`, so the caps apply even when only `--max-age`/`--keep-last` are given (see Job retention) |
| `pol bindings [--trigger <id>] / bindings get <id>` | router binding inspection |
| `pol routers [list] / routers init <name>` | router plugin management |
| `pol hooks / hook create|inbox|wait|gc|test` | webhook endpoints, temporary hooks |
| `pol github create-pr-router / install-pr-router` | PR review router scaffolding + GitHub webhook install |
| `pol daemon install|uninstall|start|stop|restart|status|logs|run` | service management |
| `pol satellite run --target … --secret …` | public relay → local daemon |
| `pol --version [--json]` | version and the commit this build came from (`dist/build-info.json`) |
| `pol status / ledger [-n N] [--follow]` | dashboard (incl. job file count, size, store and crash-loop warnings) / event stream |

Answering "why didn't my trigger fire?": check `pol ledger -n 200` for
`delivery.filtered`, `router.open_filtered`, `webhook.rejected`,
`webhook.duplicate`, `delivery.duplicate`, `router.unbound`, or `delivery.throttled` events, then
`pol daemon logs` for daemon lifecycle and binding-GC lines.

## Trigger TOML schema

Everything lives under `[trigger]`. camelCase and snake_case keys are both
accepted (`openOn` ≡ `open_on`).

```toml
[trigger]
id = "my-trigger"            # defaults to filename / slug of name
name = "my-trigger"
description = "optional"
cwd = "/path/for/commands"   # template-rendered; default cwd for actions
tags = ["github"]
enabled = true

[trigger.source]
kind = "schedule" | "poll" | "webhook" | "manual"

# kind = "schedule":
[trigger.source.timing]
type = "every" | "cron" | "once"
interval = "5m"              # every; durations: 500ms 30s 5m 2h 1d
startAt = "2026-06-11T08:00:00Z"  # every only, optional: fires at startAt + n × interval, nothing before
expression = "0 8 * * 1-5"   # cron
timezone = "UTC"             # cron only
at = "2026-06-11T08:00:00Z"  # once
missedFirePolicy = "skip" | "fire-once" | "fire-all"

# kind = "poll":
[trigger.source.poll]
interval = "30s"
emit = "per-item" | "per-poll"
baseline = false             # true: the first check (no cursor yet) records the cursor and emits nothing
[trigger.source.poll.fetch]
kind = "command" | "http" | "file"   # command=…, url=…/method=…/headers, path=…
[trigger.source.poll.cursor]
strategy = "hash" | "append-offset" | "jsonpath"  # jsonpath = "$.items[*].id"

# kind = "webhook":
[trigger.source.webhook]
path = "github/myrepo/pr"    # served at /hook/<path>
secret = "env:HOOK_SECRET"   # literal or env:NAME; HMAC sha256 (sha1 for vercel)
deliveryIdHeader = "x-event-id"  # optional; provider header carrying a stable delivery id
[trigger.source.webhook.transform]   # optional jsonpath remap of the payload
title = "$.pull_request.title"

[trigger.filter]             # drop activations whose payload doesn't match
status = "done"              # equality (deep JSON compare)
agent = true                 # `true` means "key must exist"

[trigger.delivery]
mode = "immediate" | "throttled" | "batched" | "debounced"
maxConcurrent = 1
interval = "1m"              # throttled (+ collect = true to batch suppressed events)
window = "30s"               # batched
maxBatch = 10                # batched
quietPeriod = "20s"          # debounced
maxQueued = 1000             # beyond it the newest activation is dropped (pollinate.delivery.dropped)

[trigger.retry]              # optional; without it every job gets one attempt (see Retry)
maxAttempts = 8              # total tries; default 1
backoff = "2s"               # first delay, doubling per attempt, ±20% jitter
maxBackoff = "5m"
maxElapsed = "1h"            # no attempt starts later than this after the first
on = ["transport", "timeout", "status:408", "status:429", "status:5xx"]   # default depends on the action kind

[trigger.context]            # extra template vars resolved before the action
[[trigger.context.sources]]
var = "diff"
kind = "command" | "http" | "file" | "honeybee"
command = "gh pr diff {{pr_number}}"
# kind = "honeybee": query is argv for a hive read, without the leading `hive`,
# e.g. query = "seal list --json" or query = "mailbox {{bee}} --unread --json"
[trigger.context.static]
team = "platform"

[trigger.lifecycle]          # any source; pol hook create/inbox/wait sets it for temporary hooks
temporary = true             # removed (with its state) once spent or expired and no job is in flight
expiresAt = "…"              # no delivery at or after this time
maxDeliveries = 1            # disabled after this many deliveries (count; until = expiresAt)

[trigger.action]             # required unless [trigger.router] is present
kind = "command" | "http" | "emit" | "honeybee" | "sequence"
```

### Action kinds

| kind | fields |
|---|---|
| `command` | `command`, `cwd?`, `timeout?` — runs through the configured shell |
| `http` | `method`, `url`, `headers?`, `body?`, `timeout?` — also sends `Idempotency-Key` and `X-Pollinate-Delivery` (the delivery id), `X-Pollinate-Trigger` and `X-Pollinate-Attempt` unless `headers` sets them (case-insensitive) |
| `emit` | `subject`, `payload?` — appends a ledger event only |
| `honeybee` | `run = "spawn"\|"send"\|"kill"` (below) |
| `sequence` | `mode = "serial"\|"parallel"`, `primary?`, `continueOnError?`, `actions = [{id, action}]` |

Honeybee runs (executed argv-style, never through a shell — payload text cannot
inject commands) use the hive v2 grammar:

- `spawn`: `bee` (required), `name?`, `colony?`, `home?`, `cwd?`, `yolo?`,
  `args?`, `message?` (alias `prompt`), `timeout?`. Runs
  `hive spawn <name> --agent <bee> --json`, adding `--cwd <cwd>`,
  `--tag colony=<colony>`, `--account <home>` and one `--arg <value>` per
  entry of `args` (`yolo = true` prepends the harness's own bypass flag).
  `name` defaults to `pol-<delivery id>`. When `message` is set it is then sent
  with `hive send <handle> <message>`. The spawn result handle must match
  `^[A-Za-z0-9._:-]+$`; garbage hive output fails the action loudly instead of
  binding silently.
- `send`: `target`, `message`, `timeout?` — `hive send <target> <message>`
- `kill`: `target`, `timeout?` — `hive stop <target>`; the bee stays revivable,
  Pollinate never runs `hive delete`

Removed kinds are refused. `pol add` and `pol create` exit 1 with the
replacement; an existing trigger file that uses one is skipped at load and
ledgered `pollinate.trigger.invalid`. The messages from `src/config.ts`:

| removed | replacement |
|---|---|
| `kind = "hermes"` | use a `"command"` action that runs hermes instead |
| `honeybee run = "buz"` | use `run = "send"` instead |
| `honeybee run = "comb"` | schedule a `run = "spawn"` or `run = "send"` instead |
| `honeybee run = "flow"` | schedule a `run = "spawn"` or `run = "send"` instead |
| `honeybee run = "loop"` | schedule a `run = "spawn"` or `run = "send"` instead |

### Router triggers

```toml
[trigger.router]
plugin = "github-pr"         # built-in, or a name in ~/.pollinate/router-plugins/
openOn  = ["github.pull_request.opened", "github.pull_request.reopened"]
closeOn = ["github.pull_request.closed", "github.pull_request.merged"]
idleTtl = "48h"              # GC closes bindings idle longer than this
[trigger.router.openWhen]    # same filter semantics, applied to the open event payload
pr_author = "trmdy"
[trigger.router.onOpen]      # action; its handle becomes binding.target
[trigger.router.onActivity]  # action; runs for every non-open/non-close event
[trigger.router.onClose]     # optional; defaults to honeybee kill {{binding.target}} (hive stop)
```

Binding lifecycle: `pending → active → closing → closed`, with `errored` on
onOpen failure. Open events on an existing active binding ledger
`router.already_bound` and do not respawn. Activity failures (e.g. `hive send`
to a dead session) record `error` on the binding and ledger
`router.activity_errored` — the binding stays active and later activity retries.

The daemon GC sweeps bindings every `defaults.bindingGcMs` (default 60s):

- **idleTtl** — active bindings idle past `idleTtl` are closed via onClose.
- **errored retry** — errored bindings are re-opened from the stored open
  context, up to 3 attempts, then abandoned (ledger `binding_expired`,
  reason `open-retries-exhausted`).
- **stale pending** — pending bindings older than 10 min (daemon died mid-open)
  are marked errored so the retry pass re-drives them.
- **reconciliation** — for plugins exporting `subjectState` (built-in
  `github-pr` shells out to `gh pr view --json state`), active bindings quiet
  for 5+ min are checked; closed/merged subjects are closed via onClose
  (ledger `binding_reconciled`).

### Router plugin contract (`pol routers init <name>`)

```js
export default {
  name: "my-plugin",
  // Map a webhook delivery to zero or more canonical events.
  normalize({ headers, body, path }) {
    return [{ subjectKey: "my:subject#1", kind: "my.opened", payload: { …, activity_markdown: "…" } }];
  },
  // Optional: "open" | "closed" | "unknown" — enables GC reconciliation.
  async subjectState(subjectKey, { cwd, execution }) { return "unknown"; },
};
```

## Template variables

`{{var}}` placeholders render in action strings, keys, and `cwd`. Unresolved
vars stay literal and surface as job warnings.

Plain (non-router) actions:

| var | value |
|---|---|
| `trigger_id`, `source_kind`, `fired_at` | activation metadata |
| `delivery_id` | the job's delivery id (see Delivery identity) |
| `delivery_ids` | JSON array of member delivery ids (one entry unless batched) |
| `job_id`, `attempt` | the job id; attempt number, starting at `1` |
| `scheduled_at` | schedule triggers only: the occurrence being fired |
| `event` | JSON of the (transformed) payload |
| `batch`, `batch_count` | JSON array of batched payloads / count |
| `<context vars>` | from `[trigger.context]` static + sources |

Router actions (onOpen / onActivity / onClose) get the canonical event payload
plus:

| var | value |
|---|---|
| `event_kind`, `subject_key`, `binding_id` | routing metadata |
| `delivery_id`, `attempt`, `job_id` | execution id: `<job delivery id>:<subject_key>:<open\|activity\|close>`; GC-driven runs use `gc:<binding id>:<open\|close>:<attempt>` (no `job_id`) |
| `binding.target` (and `target`) | bound hive handle |
| `binding.targets.<stepId>` | per-step handles for sequence/swarm onOpen |

`github-pr` payload fields: `provider`, `repo`, `repo_owner`, `repo_name`,
`repo_slug`, `pr_number`, `pr_url`, `pr_title`, `pr_state`, `pr_author`,
`action`, `actor`, `merged`, `activity_markdown` (ready-to-send summary),
`activity_url`, `comment_body`, `review_body`, `review_state`, `file_path`,
`line`, `check_name`, `check_status`, `check_conclusion`. Event kinds follow
`github.<webhook_event>.<action>`, with `github.pull_request.merged` synthesized
when a close has `merged: true`.

## Loop prevention contract

Bees that post PR comments **must** include `<!-- pollinate-router -->` at the
top of the comment. The `github-pr` plugin drops comments containing that
marker, which is the only thing preventing a bee's own comment from re-waking
it. Keep review bees read-only (`--allowedTools` with `gh pr view/diff/comment`,
`Read`, `Grep`, …) — comment bodies are untrusted prompt input.

## Schedules and missed fires

A schedule fire's payload (`{{event}}`) is
`{"scheduled_at": "<occurrence ISO>", "missed": <n>, "late_ms": <ms>}`:
`missed` is how many missed occurrences this fire stands for (0 on time, 1 for
a missed `once` and for each `fire-all` catch-up, all of them for a `fire-once`
catch-up) and `late_ms` is fire time minus `scheduled_at`.

An occurrence is missed when the daemon was down at start (`detected:
"startup"`: any overdue occurrence) or when a tick finds that the occurrence
after the due one is also due (`detected: "tick"`, e.g. the process was
suspended by sleep or `SIGSTOP`). The rule is the same for `every`, `cron` and
`once`. Each catch-up writes one `pollinate.schedule.missed` with `policy`,
`scheduled_at` (the first missed occurrence), `missed_count` and `detected`,
then applies `missedFirePolicy`:

- `skip` (default): no fire; next is the first occurrence after now.
- `fire-once`: one fire with `scheduled_at` set to the latest due occurrence
  and `missed` set to `missed_count`; next is the first occurrence after now.
- `fire-all`: one fire per missed occurrence, oldest first, at most 100 per
  catch-up; then next is the first occurrence after now.

`missed_count` is counted up to 10,000 occurrences; beyond that the entry
carries `missed_count_capped: true` and `fire-once` still uses the latest
occurrence.

A single late occurrence (the next one not yet due) fires as usual with
`missed: 0`. For `every` under `skip` or `fire-once`, a fire later than its
grace (10% of the interval, at least 5 s, at most 60 s) sets next to now plus
the interval, so it is not followed by an on-time fire seconds later.
`fire-all` keeps the original cadence.

## Lifecycle, baseline and state cleanup

- `lifecycle.deliveries` counts every delivery of a trigger that has a
  `[trigger.lifecycle]` table. Webhooks count on receipt (ledger
  `pollinate.hook.delivered`); schedules and polls count in delivery, after
  dedup and `[trigger.filter]` (ledger `pollinate.trigger.delivered {trigger_id,
  source, deliveries, max_deliveries, disabled}`). Reaching `maxDeliveries`
  disables the trigger; past `expiresAt` nothing is delivered.
- A `temporary` trigger that is spent or expired is removed only when it has no
  non-terminal job (anything but `completed`, `errored`, `timed-out`,
  `cancelled`, so `queued`, `running` and `retrying` all block) and nothing in
  its delivery state (`queue`, `inFlight`, `admitting`, pending batch), so a
  running or retrying job is never cut off. The GC runs at daemon start, on every trigger reload and on
  `pol hook gc`; it ledgers `pollinate.trigger.spent {trigger_id, reason:
  "expired" | "max_deliveries", source, deliveries, max_deliveries?,
  expires_at?}`, then `pollinate.trigger.removed` (webhooks also keep
  `pollinate.hook.gc_removed`).
- State follows the trigger. Removing a trigger (any way) drops its entries from
  every per-trigger state file: `schedule-state`, `delivery-state`, `cursors`,
  `deliveries-seen`, `trigger-health` (`TRIGGER_STATE_FILES` in `src/store.ts`).
  At daemon start the same prune drops entries of trigger ids with no file in
  `triggers/`. Each prune that removes something ledgers `pollinate.state.pruned
  {entries, files: {<file>: {before, after}}}` with `trigger_id` (on removal)
  or `reason: "startup"`.
- `[trigger.source.poll] baseline = true`: when the trigger has no cursor yet
  (new, or re-added after removal) the first check stores the cursor, emits
  nothing and ledgers `pollinate.poll.baselined {trigger_id, item_count}`.
  Later checks report only changes. Default `false`: the first check emits
  everything it sees, as before.

## One daemon per store

`daemon run` takes `state/daemon.lock` before anything else, then restores
queued deliveries, listens for webhooks, and only then starts schedules and
polls. The lock file holds `pid`, `startedAt` and a token; the daemon touches
its mtime every 10 s.

- A lock is stale when its pid is dead or its mtime is older than 30 s (e.g. a
  daemon killed with `-9`); a new start removes it and takes over.
- A live lock refuses the start: the process ledgers
  `pollinate.daemon.refused {reason: "locked", pid: <holder pid>}`, prints the
  holder and exits 1 within about a second. A refused start is not recorded in
  `state/daemon-runs.json`.
- Any failed start (lock refused, `EADDRINUSE`, bad config) releases the lock
  and exits 1 before schedules and polls start.
- If the heartbeat finds the lock owned by another daemon (one that took over
  a lock gone stale, e.g. while this process was suspended), this daemon ledgers
  `pollinate.daemon.refused {reason: "lock_lost", pid: <new holder>}`, stops,
  and exits 1.
- A clean stop removes the lock.

## Webhooks

- Local endpoint: `POST /hook/<path>` on `127.0.0.1:3978` (configurable via
  `[webhook]` in `pollinate.toml`; `publicUrl` powers printed URLs).
- Signatures: `x-hub-signature-256` / `x-pollinate-signature` / `x-signature`
  (HMAC-SHA256 hex), or `x-vercel-signature` (SHA1). No secret ⇒ any POST fires.
- Rejected signatures ledger `pollinate.webhook.rejected` with a `reason`.
- Redeliveries: a repeated provider delivery id per trigger (see Delivery
  identity) is accepted with `{duplicate: true}` but not dispatched (ledger
  `pollinate.webhook.duplicate`). The record lives in
  `state/deliveries-seen.json`, so it survives daemon restarts. Accepted
  deliveries answer `{accepted: true, delivery_id}`.
- Relay: `pol satellite run` on a public host forwards `/hook/*` to the local
  daemon's `/relay/*` with a timestamped HMAC (`[webhook.relay] secret`).

## Daemon config (`~/.pollinate/pollinate.toml`)

```toml
[webhook]
bind = "127.0.0.1"
port = 3978
publicUrl = "https://hooks.example.com"
[webhook.relay]
secret = "env:RELAY_SECRET"
maxAgeSeconds = 300

[defaults]
contextTimeout = "5s"
commandTimeout = "10m"
hiveStartingWait = "15m"     # how long a hive call keeps retrying while Honeybee is starting (see below)
tickMs = 1000
triggerReloadMs = 1000
bindingGcMs = 60000          # router binding GC sweep interval

[execution]                  # shell profile for command actions / polls
shell = "/bin/sh"
shellArgs = ["-c"]
inheritEnv = true
[execution.env]
PATH = "…"

[retention]
jobsMaxAge = "14d"           # terminal jobs older than this are GC-eligible
jobsKeepLastPerTrigger = 50  # floor: newest N terminal jobs of each *existing* trigger survive the age rule
jobsMaxPerTrigger = 500      # cap: only the newest N terminal jobs per trigger id are kept, regardless of age
jobsMaxTotal = 20000         # cap: only the newest N terminal jobs overall are kept, regardless of age or trigger
jobsWarnFiles = 25000        # warn (daemon.log, ledger, pol status) when the jobs folder holds this many files (above the caps: means they are not holding)
jobsWarnMb = 1024            # ... or this many MB
jobsGcMs = 3600000           # jobs + ledger retention sweep interval (default: hourly)
ledgerMaxMb = 64             # ledger.jsonl is rotated to ledger.jsonl.1 past this size
```

## Honeybee starting window

While Honeybee backs up and migrates its store, `hive` refuses every call with
`daemon_starting` (the CLI holds 15 s first, then exits 1) and `hive health`
exits 75. A first start on a large store on a loaded Mac can take minutes.

- Every `hive` call Pollinate makes (honeybee actions, router actions,
  honeybee context sources) retries on exactly those two signals:
  `error (daemon_starting)` on stderr or `error.code = "daemon_starting"` in
  `--json` output, or `hive health` exit 75. Any other failure, including a
  timeout, fails as before.
- Backoff 1 s, doubling, capped at 15 s, on top of the CLI's own 15 s hold.
  The wait is bounded by `defaults.hiveStartingWait` (default `15m`) from the
  first refusal; the final attempt can add one 15 s hold. 15 min covers a
  1.3 GB store on the worst measured Mac load (21 s on Linux × 23 ≈ 8 min)
  with about 2× headroom, and still fails a daemon that is stuck.
- Exactly once: only the refused call is retried, inside the same job. A
  refused call was never accepted by Honeybee, the scheduler reserved the fire
  before queueing the job, and no new job is created, so a retry cannot
  deliver twice. In a spawn+message action a succeeded spawn is not repeated.
- Each refusal ledgers `pollinate.job.hive_starting` and updates the job's
  `hiveStarting` field (`refusals`, `firstRefusedAt`, `lastRefusedAt`,
  `lastCommand`, `lastMessage`). Cancelling the job stops the wait.
- Honeybee context sources apply their `timeout` per attempt; give them more
  than 15 s if they should ride out the CLI hold.
- Pollinate restarting during the wait marks the job errored at startup
  ("daemon restarted mid-execution"), unless the trigger has a
  `[trigger.retry]` policy, which resumes it (see Retry).

## Job retention

`~/.pollinate/jobs/<jobId>.json` gets one file per execution. Nothing but this
sweep removes them. In November 2026, 56,531 files (3.4 GB, one PR router made
46k of them inside 14 days) made every daemon start parse all of them and run
out of heap; launchd restarted it every 16 s for seven hours.

- Job files are written with the small fields first (`id`, `uuid`, `triggerId`,
  `source`, `status`, `queuedAt`, `startedAt`, `completedAt`). Scans (startup
  recovery, the sweep, `pol jobs`, `pol status`, `pol job <ref>`, job-id
  repair) read only the first 4 KB of each file and stream the folder; files
  in the older key order fall back to reading that one file. Only the jobs a
  listing returns are parsed in full, so memory does not grow with the number
  of files.
- The daemon listens first, then recovers stale jobs and runs the sweep in the
  background at startup, then every `retention.jobsGcMs`. A trigger that
  creates `jobsMaxPerTrigger / 2` jobs, or all triggers together
  `jobsMaxTotal / 4`, since the last sweep start an early sweep (at most one a
  minute). Failures are logged and never crash the daemon.
- Only **terminal** jobs (`completed`, `errored`, `timed-out`, `cancelled`) are
  ever removed. Rules, in order of strength:
  1. caps: beyond the newest `jobsMaxPerTrigger` of a trigger id, or the newest
     `jobsMaxTotal` overall, a job is removed whatever its age (by
     `completedAt`, falling back to `queuedAt`);
  2. age: a job older than `jobsMaxAge` is removed unless it is one of the
     newest `jobsKeepLastPerTrigger` of a trigger that still has a trigger
     file. Jobs of removed triggers (one-shot hooks, cancelled wake-ups) get no
     floor and age out.
- Each sweep removes job-id index entries whose job files are gone, and writes
  `state/jobs-store.json`. The daemon log gets one `jobs store: N files, X MB`
  line per sweep and a `WARNING` line (plus ledger `pollinate.jobs.store_warning`)
  past `jobsWarnFiles` / `jobsWarnMb`.
- Crash loops: every start is recorded in `state/daemon-runs.json`; a start that
  finds 3+ runs without a clean stop in 10 minutes logs `WARNING crash loop` and
  ledgers `pollinate.daemon.crash_loop`. `pol status` reads the same file, so it
  shows unclean exits even while the daemon is down.
- Ledger rotation is size-based: once `ledger.jsonl` exceeds
  `retention.ledgerMaxMb`, it's renamed to `ledger.jsonl.1` (replacing any
  previous generation) and lazily recreated on the next append. `pol ledger`
  only reads the active file.
- Manual control: `pol jobs gc [--max-age <dur>] [--keep-last <n>]
  [--max-per-trigger <n>] [--max-total <n>] [--dry-run]`. Flags default to the
  `[retention]` config; `--dry-run` reports what would be removed, per trigger.

## Retry

`[trigger.retry]` (keys also `max_attempts`, `max_backoff`, `max_elapsed`)
retries a failed `[trigger.action]` job inside the same job, with the same
delivery id, so receivers see one `Idempotency-Key` and an increasing
`X-Pollinate-Attempt` / `{{attempt}}`. Router triggers (`[trigger.router]`
without `[trigger.action]`) ignore it.

- Delay before attempt n+1: `backoff × 2^(n-1)`, ±20% jitter, at most
  `maxBackoff`. An http `Retry-After` (seconds or date) replaces it, capped at
  `maxBackoff`. No retry is scheduled whose start would be more than
  `maxElapsed` after the first attempt started.
- `on` lists the failure classes that retry: `transport` (connection error),
  `timeout`, `status:<code>`, `status:<n>xx`, `exit` (command exited non-zero)
  and hive error codes (`error (<code>)` on stderr or `error.code` in JSON).
  Defaults: `http` → `transport`, `timeout`, `status:408`, `status:429`,
  `status:5xx` (other 4xx are final); `honeybee` → `hived_handover_stalled`,
  `socket_unreachable`, `timeout` (the `daemon_starting` wait stays inside one
  attempt); `command` and `emit` → nothing, because commands need not be
  idempotent; `sequence` → the union of its steps. A retried sequence runs all
  its steps again.
- Between attempts the job is `retrying` (non-terminal) with `nextAttemptAt`.
  The job records `attempt` and `attempts` (the last 10: `attempt`,
  `startedAt`, `endedAt`, `error`, `retryable`). A retrying job keeps its
  `maxConcurrent` slot, so later fires of the trigger wait behind it.
- Durable: `state/delivery-state.json` keeps every job from queued to terminal
  (`queue`, then `inFlight` with the job, activation and batch). Before a
  delivery id is claimed in `deliveries-seen.json` (webhooks included, before
  the 202), the activation is written to `admitting` with the claim time; it
  leaves `admitting` in the same write that makes it a queued job or a pending
  batch member, or when it is filtered, throttled or dropped. At startup an
  admission whose claim is ours (same time) or missing is dispatched; one
  claimed by someone else is a duplicate.
- At startup an in-flight `retrying` job, or a `running` /
  `resolving-context` job of a trigger with a retry policy, is resumed with
  the same delivery id; an interrupted attempt counts as failed (and
  retryable). Ledger `pollinate.job.resumed {job_id, trigger_id, delivery_id,
  attempt, next_attempt_at, recovered_from}`. Other interrupted jobs are
  marked errored as before ("daemon restarted mid-execution"). The stale job
  sweep also hands orphaned `retrying` jobs (e.g. from a killed
  `pol trigger`) to the daemon.
- `pol trigger` runs the retries in the foreground and returns the terminal
  job.
- Removing or disabling a trigger cancels its queued and retrying jobs
  (`pollinate.job.cancelled` with `reason: "trigger-removed"`). Triggers that
  disabled themselves (a fired `once` schedule, `maxDeliveries` reached) keep
  their jobs. A running attempt finishes; it is not retried.
- Ledger: each scheduled retry `pollinate.job.retry_scheduled {job_id,
  trigger_id, delivery_id, attempt, retry_in_ms, error}`; the final
  `pollinate.job.errored` carries `attempts` and `gave_up` (true when the
  failure was retryable but attempts or `maxElapsed` ran out).

## Delivery identity

Every activation, and so every job (`Job.deliveryId`), has a delivery id
`<trigger_id>:<part>`:

| source | part | deduped |
|---|---|---|
| schedule | `sched:<scheduled_at>` | yes |
| webhook with a provider id | `wh:<id>` from the `deliveryIdHeader` header, else `x-github-delivery`, `svix-id`, `idempotency-key`, `x-pollinate-delivery` | yes |
| webhook without one | `wh:<uuid>`; two identical bodies stay two deliveries | no |
| poll | `poll:<checked_at>:<index>` | no |
| `pol trigger --delivery-id <id>` | `<id>` | yes |
| `pol trigger` | `manual:<uuid>` | no |
| batched, debounced, throttle-collected job | `batch:<first 16 hex of sha256 of the member ids joined by newlines>` | no |

Sequence steps run with `<delivery id>.s<n>`. Deduped ids are recorded in
`state/deliveries-seen.json` (per trigger: newest 2,000 ids, 72 h; pruned on
every write and when the trigger is removed, see Lifecycle, baseline and state cleanup). A repeat is not fired: webhooks
answer `{duplicate: true}` and ledger `pollinate.webhook.duplicate`, other
sources ledger `pollinate.delivery.duplicate {trigger_id, delivery_id, source}`.
A crash between recording an id and running its job no longer loses the
delivery (see Retry: admissions); a lost write of the record allows one
duplicate. Receivers should key on
`Idempotency-Key` / `{{delivery_id}}`.

## Ledger events

Append-only JSONL at `~/.pollinate/ledger.jsonl`; every entry has `ts` and
`event`. Stream with `pol ledger --follow`.

- `pollinate.trigger.{added,enabled,disabled,removed,delivered,spent}` (see Lifecycle, baseline and state cleanup)
- `pollinate.state.pruned` (per-trigger state removed with its trigger or at startup)
- `pollinate.trigger.invalid` (a trigger file that fails to load, e.g. one
  using a removed action kind; once per file change, keyed on path, mtime and size)
- `pollinate.job.{queued,started,completed,errored,cancelled,hive_starting,retry_scheduled,resumed}`
- `pollinate.delivery.{filtered,throttled,duplicate,dropped}`
- `pollinate.schedule.{fired,missed,errored}` · `pollinate.poll.{checked,detected,errored,baselined}`
- `pollinate.webhook.{received,rejected,duplicate}`
- `pollinate.hook.{created,delivered,expired,gc_removed}`
- `pollinate.router.{binding_pending,binding_created,binding_routed,binding_closed,binding_errored,binding_retry,binding_expired,binding_reconciled,already_bound,unbound,open_filtered,activity_errored,gc}`
- `pollinate.router.plugin.created` · `pollinate.github.webhook.installed`
- `pollinate.schedule.missed` carries `policy`, `scheduled_at` (first missed
  occurrence), `missed_count`, `detected: "tick" | "startup"` and, past 10,000,
  `missed_count_capped` (see Schedules and missed fires)
- `pollinate.daemon.{started,stopped,triggers_reloaded,reload_errored,crash_loop,refused}`;
  `refused` carries `reason: "locked" | "lock_lost"` and the lock holder's `pid`
  (see One daemon per store)
- `pollinate.jobs.{gc,store_warning}` · `pollinate.ledger.rotated` (job/ledger retention, see Job retention)
- `pollinate.emit` (from `emit` actions)

## Job IDs

Jobs use Honeybee-style IDs `<TRIGGER-PREFIX>.<uuid-prefix>` (e.g. `HE.a3f`).
`pol job <ref>` accepts the visible id, the suffix, or a longer UUID prefix.
Terminal statuses: `completed`, `errored`, `timed-out`, `cancelled`.
Non-terminal: `queued`, `resolving-context`, `running`, `retrying`.
