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
  print `{"error": "..."}` to stderr and exit 1. Header values are redacted
  in every `--json` output (see Bounds and redaction).
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
- `--json` also carries `api: 1`, the local API version this build serves.

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
  state/trigger-health.json       per-trigger failure streaks and onFailure notifications (see Failure reporting)
  state/trigger-health.lock       lock for trigger-health.json
  state/job-id-index.json         UUIDs used for visible job ID suffixes
  state/job-id-index.lock         lock for the job ID index
  state/jobs-store.json           last retention sweep: job file count, bytes, largest triggers, warnings
  state/daemon-runs.json          last 20 daemon starts/clean stops (crash-loop detection)
  state/daemon.lock               one daemon per store: pid, start time, token; mtime is the heartbeat
  state/store.json                store metadata {schema: 1}; a newer schema refuses the daemon start
  state/ledger.json               ledger generation {generation, rotating?} (see Events stream)
  state/trigger-tags.json         tags of live and recently removed triggers, for the events tag filter
  state/trigger-locks/<id>.lock   per-trigger write locks
  state/job-locks/<jobId>.lock    per-job write locks
  state/router-bindings/<trigger>/<subject>.json   binding records
  state/router-bindings/<trigger>/<subject>.lock   binding write locks
  jobs/<jobId>.json               one job per execution
  ledger.jsonl                    append-only event log (the source of truth)
  ledger.jsonl.1                  previous ledger generation (size-based rotation, see Job retention and Events stream)
  daemon.log                      daemon lifecycle + GC log (pol daemon logs)
  daemon.log.1                    previous daemon.log (rotated past 10 MB by the daemon and pol doctor --fix)
  daemon.out.log                  macOS launchd stdout log
  daemon.err.log                  macOS launchd stderr log
  pollinate.toml                  daemon config
  pollinated.sock                 local API v1 socket (0600, only while the daemon runs)
```

## CLI map

| Command | Purpose |
|---|---|
| `pol add / create / list / get / enable / disable / edit / remove` | trigger CRUD; `edit` validates the TOML on editor exit |
| `pol trigger <id> [--payload '{…}'] [--delivery-id <id>] [--dry-run]` | fire manually (through the daemon's queue when it runs, see Local API); a repeated `--delivery-id` answers `duplicate` and does not fire |
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
| `pol doctor [--json] [--fix]` | check daemon, hive, triggers, bindings, state and config; exit 0 clean, 1 warnings, 2 errors (see Doctor) |
| `pol why <trigger> [--json]` | the trigger's last 20 activations from the ledger, each with its outcome (see Doctor) |

Answering "why didn't my trigger fire?": start with `pol why <trigger>`, or check `pol ledger -n 200` for
`delivery.filtered`, `router.open_filtered`, `webhook.rejected`,
`webhook.duplicate`, `delivery.duplicate`, `router.unbound`, or `delivery.throttled` events, then
`pol daemon logs` for daemon lifecycle and binding-GC lines. "Is it failing?":
`state/trigger-health.json` and `pollinate.trigger.failed` (see Failure reporting).

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

[trigger.onFailure]          # optional; see Failure reporting (also on_failure)
after = 1                    # consecutive failures before notifying
cooldown = "1h"              # at most one notification per cooldown while still failing
disabled = false             # true: never notify, not even through [defaults.onFailure]
[trigger.onFailure.action]   # any action kind; rendered with the failure vars
kind = "http"

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
| `command` | `command`, `cwd?`, `timeout?` — runs through the configured shell; the job keeps the last 1 MB of stdout and of stderr |
| `http` | `method`, `url`, `headers?`, `body?`, `timeout?` — also sends `Idempotency-Key` and `X-Pollinate-Delivery` (the delivery id), `X-Pollinate-Trigger` and `X-Pollinate-Attempt` unless `headers` sets them (case-insensitive); the job keeps the first 64 KB of the response body |
| `emit` | `subject`, `payload?` — appends a ledger event only |
| `honeybee` | `run = "spawn"\|"send"\|"stop"` (`"kill"` is an alias of `"stop"`; below) |
| `sequence` | `mode = "serial"\|"parallel"`, `primary?`, `continueOnError?`, `actions = [{id, action}]` |

Honeybee runs (executed argv-style, never through a shell — payload text cannot
inject commands) use the hive v2 grammar. Every call passes `--json` and an
`--idempotency-key` derived from the job's delivery id, so a retried or
resumed job (same delivery id) cannot create a second bee or a second
message. Sequence steps get their own key (`<delivery id>.s<n>:…`).

- `spawn`: `agent` (required; alias `bee`), `name?`, `account?` (alias
  `home`), `tags?` (array), `title?`, `colony?` (adds the tag
  `colony=<colony>`), `cwd?`, `yolo?`, `args?`, `message?` (alias `prompt`),
  `timeout?`. Runs `hive spawn <name> --agent <agent> --no-parent
  --idempotency-key <delivery id>:spawn --json`, adding `--cwd`, `--account`,
  `--title`, one `--tag` per tag and one `--arg <value>` per entry of `args`
  (`yolo = true` prepends the harness's own bypass flag). `name` defaults to
  `pol-<delivery id>`. When `message` is set it is then sent with
  `hive send <handle> <message> --sender-kind automation --idempotency-key
  <delivery id>:seed --json`. The spawn result handle must match
  `^[A-Za-z0-9._:-]+$`; garbage hive output fails the action loudly instead of
  binding silently.
- `send`: `target`, `message`, `urgency?` (`"now"`, `"next"` or `"idle"`,
  passed as `--urgency`), `timeout?` — `hive send <target> <message>
  --sender-kind automation --idempotency-key <delivery id>:send --json`.
- `stop` (alias `kill`): `target`, `timeout?` — `hive stop <target>
  --idempotency-key <delivery id>:stop --json`; the bee stays revivable,
  Pollinate never runs `hive delete`. `bee_not_found` (or a message saying the
  bee is already stopped) counts as success with result
  `{stopped: false, alreadyStopped: true}`, so router `onClose` closes the
  binding.
- A message whose first character is `-` is sent with one leading space:
  `hive` reads any `--…` token as a flag and `send` ignores a body after `--`.
- Failures: hive prints `{"error":{"code","message"}}` on stdout under
  `--json`. The job error reads `hive <verb>: <code>: <message>` and the job's
  `result.hiveError` holds `{code, message}`; the code feeds `[trigger.retry]`
  (see Retry). A `protocol_mismatch` error names the resolved binary
  (`binary` in `hiveError`) and points at `[honeybee] bin`.
- Binary: `[honeybee] bin` in `pollinate.toml` (absolute path); default `hive`
  looked up on the execution PATH (`[execution.env].PATH`, else the daemon's
  own when `inheritEnv`). Honeybee context sources use the same binary. When
  any enabled trigger uses hive (a honeybee action, a router, or a honeybee
  context source) the daemon resolves the path at start, runs
  `hive --version --json` bounded to 2 s and ledgers
  `pollinate.hive.probed {path, version, ok, error?}`.

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
idleTtl = "48h"              # GC closes bindings idle longer than this (default "7d")
[trigger.router.openWhen]    # same filter semantics, applied to the open event payload
pr_author = "trmdy"
[trigger.router.onOpen]      # action; its handle becomes binding.target
[trigger.router.onActivity]  # action; runs for every non-open/non-close event
[trigger.router.onClose]     # optional; defaults to honeybee stop {{binding.target}} (hive stop)
```

Binding lifecycle: `pending → active → closing → closed`, with `errored` on
onOpen failure. Open events on an existing active binding ledger
`router.already_bound` and do not respawn. Activity failures (e.g. `hive send`
to a dead session) record `error` on the binding and ledger
`router.activity_errored` — the binding stays active and later activity retries.

Open limit: per trigger, at most 30 binding creations a minute and 100 bindings
that are not `closed`. Only new bindings count (an open event on a subject with
no binding, or a closed or errored one); the check runs inside the router after
`normalize`, so activity and close events on a bound subject are never refused.
A refused open is dropped (no binding file, no onOpen) and ledgers
`router.open_rate_limited` with `reason` `open rate limit` or `open binding cap`.
The webhook answers 202 either way.

The daemon GC sweeps bindings every `defaults.bindingGcMs` (default 60s):

- **idleTtl** — active bindings idle past `idleTtl` (default `7d` when unset)
  are closed via onClose.
- **stuck closing** — a failed onClose leaves the binding `closing` with
  `error` and `closeAttempts`. A `closing` binding last updated 10+ min ago is
  retried via onClose (ledger `binding_retry`, `phase = "close"`) up to 3
  times; when the last retry fails it is closed with the error (ledger
  `binding_expired`, reason `close-retries-exhausted`). This runs for every
  router, with or without `idleTtl` or `subjectState`.
- **pruning** — closed binding files whose `updatedAt` is older than
  `[router].bindingRetention` (default `7d`) are deleted (ledger
  `binding_pruned`).
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

`{{json var}}` renders the value JSON-encoded instead: a string becomes a JSON
string literal with its quotes (`"say \"hi\"\n"`), a number or object its JSON,
an undefined value `null`. Use it to put a value inside an http JSON body, e.g.
`body = '{"error": {{json failure_error}}, "id": {{json delivery_id}}}'`: quotes,
newlines and backslashes in the value no longer break the body. `{{var}}`
renders as before (raw text). `{{event}}`, `{{batch}}` and `{{delivery_ids}}` are
already JSON text, so put them in a body as `{{event}}`; `{{json event}}` gives a
string holding that JSON. In a `command` action `{{json var}}` is JSON-encoded,
then shell-quoted like any var. `json` is a prefix only when followed by a
space and a var name; a var named `json` is still `{{json}}`.

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

`[trigger.onFailure.action]` (and `[defaults.onFailure.action]`) renders with
the plain vars (`job_id`, `attempt` and `event` belong to the notification job)
plus:

| var | value |
|---|---|
| `trigger_id`, `trigger_name` | the failing trigger (the name is the id for an invalid file) |
| `failure_kind` | `job`, `poll`, `router_open`, `router_close`, `schedule` or `invalid` |
| `failure_error` | the error, cut at 2,000 characters |
| `failed_job_id`, `delivery_id` | the failed job and its delivery id; empty when the failure has none (e.g. a poll fetch) |
| `consecutive_failures`, `first_failed_at` | the streak length and when it began |
| `event` | JSON object of the vars above; use it as an http `body`, or `{{json failure_error}}` etc. in your own body |

Router actions (onOpen / onActivity / onClose) get the canonical event payload
plus:

| var | value |
|---|---|
| `event_kind`, `subject_key`, `binding_id` | routing metadata |
| `delivery_id`, `attempt`, `job_id` | execution id: `<job delivery id>:<subject_key>:<open\|activity\|close>`; a GC retry of a failed or interrupted open or close reuses that attempt's delivery id (kept on the binding as `openDeliveryId` / `closeDeliveryId`), so hive's idempotency key dedupes a spawn or stop that succeeded but was reported failed; a close the GC starts (idleTtl, reconcile) uses `gc:<binding id>:close:<binding updatedAt>`. GC runs have no `job_id`; `attempt` is `openAttempts`, or `closeAttempts + 1` for close |
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

## Local API (socket)

The daemon serves the v1 API (HTTP/1.1 + JSON, `node:http`) on
`<store>/pollinated.sock`. Every call, with a request and answer, is in
[docs/API.md](docs/API.md).

- No TCP listener, no token. The socket is mode `0600` inside the `0700` store,
  so trust is the store directory's. `POLLINATE_SOCKET` overrides the path; a
  path over 103 bytes refuses the start with a clear error.
- Start order: lock, `state/store.json` schema check, socket path check (a
  stale socket file is unlinked; a regular file there or a socket another
  process answers on refuses the start), engines, then the socket listens. So
  `GET /v1/health` answering means the daemon is ready. A daemon refused at
  the lock never touches the socket.
- Stop: requests answer `503 stopping` from the first moment of shutdown; the
  socket is closed and unlinked before the lock is released. After `kill -9`
  the socket file stays; the next start replaces it.
- API writes (`PUT`, `PATCH`, `DELETE`) go through the same store functions as
  the CLI (`putTrigger`, `setTriggerEnabled`, `removeTrigger`), then hand the
  trigger straight to delivery, schedules, polls and webhooks before
  answering. API writes and the file reload run one at a time through a single
  queue, and each pushes the daemon's current trigger list to every engine, so
  neither can leave an engine on an older list. A PUT that arrives during a
  file reload waits for it. CLI writes that fall back to files (see below)
  still arrive through the 1 s file reload.
- `PUT` of an enabled poll runs the first check inside the call: a failure is
  `422 poll_failed` and nothing is stored; otherwise the fetched result goes
  through the normal check (baseline or dispatch), and the next check follows
  one interval later.
- `POST /v1/triggers/:id/fire` uses the daemon's delivery queue, so
  `maxConcurrent`, delivery modes and dedup hold. A repeated `deliveryId`
  answers `409 conflict` and ledgers `pollinate.delivery.duplicate`.
- The CLI talks to the socket (`src/client.ts`) for `pol add` (`PUT`),
  `remove` (`DELETE`), `enable`/`disable` (`PATCH`), `trigger` (`POST …/fire`)
  and `job cancel` (`POST /v1/jobs/:id/cancel`). `pol trigger --dry-run` and
  every other command stay local. `--json` output carries `via: "daemon"` or
  `via: "files"`; `pol add` through the daemon also carries `created`,
  `webhook` (`path`, `url`, `localUrl`), `nextFireAt` for schedules and `poll`
  for the first check.
- Fallback rule: the CLI writes files instead only when the daemon cannot be
  reached (no socket file, `ENOENT`/`ECONNREFUSED`/`ENOTSOCK`, or no connect
  within 1 s) or answers `503 stopping` / `501 unsupported`, both of which come
  before the daemon acts. Once a request was sent, a lost connection, a broken
  answer or no answer within 5 min is reported as `code: "interrupted"` and
  never retried through files, so `pol trigger` cannot fire twice. API errors
  (`invalid_trigger`, `poll_failed`, `conflict`, `not_found`, …) are reported
  as they are: exit 1, and with `--json` stderr is
  `{"error": message, "code", "details"?}` (`code`/`details` are added to the
  usual `{"error"}`).
- `pol trigger` through the daemon fires with `POST …/fire`, then follows
  `GET /v1/jobs/:id` until the job is terminal (or gone) and prints it with
  today's output and exit code. If the daemon goes away while following, it
  keeps reading the job file. `{job: null}` (a debounced, throttled or batched
  mode holding the activation, a filter miss or a full queue) prints
  `held: true` with `delivery_mode`, exit 0; a repeated `--delivery-id` prints
  the usual `duplicate: true` answer, exit 0. Firing a disabled trigger answers
  `409 conflict` with `reason: "disabled"` and acts on nothing, so the CLI fires
  it through the file path as before (the same as with no daemon).
- `state/store.json` is `{"schema": 1}`, written when missing. A higher schema
  refuses the start: `store schema N in … is newer than this Pollinate supports`.
- `tests/contract-apiary.test.ts` is Apiary's contract: exactly the calls and
  fields Apiary's kernel uses. Do not loosen or delete it without Apiary's
  agreement; a change that fails it breaks Apiary.

## Doctor

`pol doctor [--json] [--fix]` reads the store (set by `POLLINATE_STORE_ROOT`) and
reports one line per check. Exit code: `0` clean, `1` warnings only, `2` any
error. `--json` prints `{store, checkedAt, status, exitCode, counts: {errors,
warnings}, findings: [{area, check, severity, message, fixable?, details?}],
fixes?}`. Without `--fix` it writes nothing. A running daemon serves the same
report read-only at `GET /v1/doctor` (see docs/API.md); there its `commit` check
compares the daemon's start commit with its build on disk.

| area | check | severity |
|---|---|---|
| daemon | no live `state/daemon.lock` holder | warning |
| daemon | daemon commit differs from the CLI's (`commit` from `pollinate.daemon.started`, else `build-info.json` next to the daemon's `cli.js`) or is unknown | warning |
| daemon | another `pollinate … daemon run` process on the same store (process list, its `POLLINATE_STORE_ROOT`, a `package.json` named `pollinate`) | error |
| daemon | crash loop (`state/daemon-runs.json`); unclean exits in the last hour without a loop are a warning | error |
| daemon | the daemon's `cli.js` is inside a git checkout | warning |
| hive | the resolved hive (`[honeybee] bin`, else the execution PATH) fails `--version --json`; a warning when no enabled trigger uses hive | error |
| hive | `hive health --json` fails (exit 75, still starting, is a warning) | error |
| hive | a different `hive` earlier on the execution PATH whose `--version --json` fails or differs from the configured one | error |
| triggers | trigger files that do not parse; files that use a removed action kind | error |
| triggers | `consecutiveFailures >= 3` in `state/trigger-health.json` | error |
| triggers | spent but present: `maxDeliveries` reached, `expiresAt` past, a `once` schedule that fired (`completedOnce`) or is disabled with `at` past | warning |
| router | errored and closing bindings per trigger; open bindings of a removed trigger | warning |
| router | closed bindings older than `[router] bindingRetention` | warning, fixable |
| state | entries in the per-trigger state files for triggers with no file | warning, fixable |
| state | jobs folder past `jobsWarnFiles` / `jobsWarnMb`; `ledger.jsonl` past twice `ledgerMaxMb` | warning |
| state | `daemon.log`, `daemon.out.log` or `daemon.err.log` over 10 MB | warning, fixable |
| state | files Pollinate does not own in the store root, `state/`, `triggers/` (non-`.toml`) or `jobs/` (non-`.json`) | warning |
| config | `[execution.env].PATH` entries that do not exist | warning |
| config | `pollinate.toml` modified after the running daemon started | warning |
| config | `pollinate.toml` does not parse | error |

`--fix` does only three things, then checks again and reports what is left:

- prunes orphan entries from `TRIGGER_STATE_FILES` (ledger `pollinate.state.pruned`
  with `reason: "doctor"`). While a daemon runs it prunes only the lock-guarded
  `deliveries-seen.json` and `trigger-health.json`; the daemon prunes the rest
  at its next start.
- deletes closed bindings past `bindingRetention` under the binding lock
  (ledger `pollinate.router.binding_pruned` with `reason: "doctor"`).
- rotates logs over 10 MB: `daemon.log` is renamed to `daemon.log.1`;
  `daemon.out.log` and `daemon.err.log` are cut in place to their last 1 MB
  (copy-truncate, because launchd holds them open).

It never removes triggers, jobs or open bindings. When it changed anything it
ledgers `pollinate.doctor.fixed {fixes: [{action, message}]}`.

`pol why <trigger> [--json]` reads `ledger.jsonl` (then `ledger.jsonl.1`) from
the end and lists the trigger's last 20 activations, newest first, with
`{at, outcome, event, jobId?, deliveryId?, status?, detail?}`. Outcomes:

| outcome | from |
|---|---|
| `fired` | `pollinate.job.queued`, ended `completed` (or still running: `status` says so) |
| `errored` | a job that ended `errored` / `timed-out`; `pollinate.schedule.errored`; `pollinate.poll.errored` |
| `filtered` | `pollinate.delivery.filtered`, `pollinate.router.open_filtered` |
| `throttled` | `pollinate.delivery.throttled` |
| `duplicate` | `pollinate.delivery.duplicate`, `pollinate.webhook.duplicate` |
| `dropped` | `pollinate.delivery.dropped`, `pollinate.router.open_rate_limited`, `pollinate.webhook.rejected`, a cancelled job |

onFailure notification jobs are not activations. The job file, when it still
exists, supplies the delivery id and the final status.

Both commands redact secrets in all output: values under keys that look like
secrets (`secret`, `token`, `password`, `authorization`, `cookie`, `api_key`,
`signature`, …), every value under a `headers` key, and bearer tokens,
`Authorization:`-style pairs and GitHub/OpenAI/Slack token shapes inside text.

## Idle cost

Every `defaults.triggerReloadMs` (1 s) the daemon lists `triggers/` and stats
each file. It parses only files whose inode, mtime or size changed since the
last pass and keeps the rest from memory; the temporary-trigger GC works from
the same list. When no file changed, nothing else happens. Any change, an
invalid file included, reloads the engines and ledgers
`pollinate.daemon.triggers_reloaded`. On a store with 800 trigger files (790
spent one-shot schedules) the idle daemon uses about 3 s of CPU per 10
minutes, down from about 77 s.

A trigger file without `updatedAt` (or `createdAt`) gets the file's mtime when
loaded. Before, it got the load time, so the trigger looked changed on every
pass and the daemon reloaded every second.

## Bounds and redaction

- Child processes (command actions, command polls and context sources, hive
  calls): the last 1 MB of stdout and of stderr is kept. When more was
  written, the result carries `stdoutDroppedBytes` / `stderrDroppedBytes`
  (bytes dropped from the front). A command printing 500 MB completes with the
  daemon under 200 MB RSS.
- A failing child's error text (`job.error`, `attempts[].error`, the
  `pollinate.job.errored` / `pollinate.poll.errored` ledger lines, context and
  hive errors) quotes only the last 2 KB of stderr, prefixed
  `[<n> earlier bytes cut]` when longer. A failed `command` action's job keeps
  `result` with `exitCode`, `stdout`, `stderr` (the 1 MB tails) and the
  dropped counts.
- `http` actions: the job's `result.body` holds the first 64 KB of the
  response; when the body is longer the rest is not read and the result
  carries `bodyTruncated: true` and `bodyKeptBytes: 65536`. The error of a
  non-2xx answer still quotes its first 500 characters.
- `daemon.log` is renamed to `daemon.log.1` (replacing the previous one) when
  a write finds it over 10 MB.
- `daemon.out.log` and `daemon.err.log` (launchd captures): at daemon start,
  a file over 10 MB is cut in place to its last 1 MB, starting at a line
  boundary (copy-truncate, because launchd holds them open in append mode).
  `daemon.log` gets a `trimmed <file> from <size> to its last <kept>` line.
  `pol doctor --fix` uses the same rotation (`rotateDaemonLogs` in
  `src/fsx.ts`).
- Header values are redacted to `<redacted>`: every `headers` table in a job
  file's `action`, and every `headers` key in any `--json` output
  (`pol list`, `pol get`, `pol job`, `pol jobs`, `pol trigger`, `pol ledger`
  including `--follow`, …). Trigger files and `state/delivery-state.json` keep
  the real values; retries and resumed jobs run from those, never from the
  job file.

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
[defaults.onFailure]         # for triggers without their own (see Failure reporting)
after = 1
cooldown = "1h"
[defaults.onFailure.action]
kind = "honeybee"
run = "send"
target = "owner"
message = "[trigger {{trigger_id}}] {{failure_kind}} failed {{consecutive_failures}}x: {{failure_error}}"

[execution]                  # shell profile for command actions / polls
shell = "/bin/sh"
shellArgs = ["-c"]
inheritEnv = true
[execution.env]
PATH = "…"

[honeybee]
bin = "/abs/path/hive"       # optional; default `hive` on the execution PATH (see Action kinds)

[retention]
jobsMaxAge = "14d"           # terminal jobs older than this are GC-eligible
jobsKeepLastPerTrigger = 50  # floor: newest N terminal jobs of each *existing* trigger survive the age rule
jobsMaxPerTrigger = 500      # cap: only the newest N terminal jobs per trigger id are kept, regardless of age
jobsMaxTotal = 20000         # cap: only the newest N terminal jobs overall are kept, regardless of age or trigger
jobsWarnFiles = 25000        # warn (daemon.log, ledger, pol status) when the jobs folder holds this many files (above the caps: means they are not holding)
jobsWarnMb = 1024            # ... or this many MB
jobsGcMs = 3600000           # jobs + ledger retention sweep interval (default: hourly)
ledgerMaxMb = 64             # ledger.jsonl is rotated to ledger.jsonl.1 past this size

[router]
bindingRetention = "7d"      # closed binding files older than this are deleted by the binding GC
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
- At startup the daemon recovers stale jobs before it starts the webhook
  server, schedules and polls, so the trigger health that onFailure reads is
  settled before the first fire (an interrupted notification releases its
  cooldown first; about 0.5 s with 20,000 job files). It then listens and runs
  the sweep in the background, then every `retention.jobsGcMs`. A trigger that
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
  previous generation) and lazily recreated on the next append. Each rotation
  bumps the generation in `state/ledger.json` (see Events stream). `pol ledger`
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
  `socket_unreachable`, `move_in_progress`, `handoff_in_progress`, `timeout`
  (the `daemon_starting` wait stays inside one attempt). Codes such as `protocol_mismatch`, `invalid_request`, `bee_not_found`,
  `idempotency_conflict` and `cli_error` are final; `command` and `emit` → nothing, because commands need not be
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

## Failure reporting

The daemon keeps `state/trigger-health.json`, keyed by trigger id:
`consecutiveFailures`, `firstFailedAt`, `lastFailureAt`, `lastFailureKind`,
`lastError` (2,000 characters at most), `lastSuccessAt` (written at most once a
minute while healthy) and `notifiedAt`.

A failure is one of:

| kind | when |
|---|---|
| `job` | a job ends `errored` or `timed-out` after its retries (a `retrying` job is not a failure yet), including one marked errored at startup ("daemon restarted mid-execution"). Router triggers' own jobs are not counted; their failures are the next two |
| `poll` | a poll check fails (fetch error, non-2xx, timeout, bad JSON for a jsonpath cursor) |
| `router_open` | the binding GC abandons an errored binding (`open-retries-exhausted` or `no-open-context`) |
| `router_close` | an `onClose` action fails, from a close event or the GC |
| `schedule` | the scheduler ledgers `pollinate.schedule.errored` for the trigger |
| `invalid` | the trigger file no longer loads (once per distinct error) |

Each failure adds one to the streak and ledgers `pollinate.trigger.failed
{trigger_id, kind, error, job_id?, delivery_id?, consecutive}`. A success ends
the streak and ledgers `pollinate.trigger.recovered {trigger_id, kind,
consecutive, first_failed_at}` (`kind` is the last failure's): a completed job
ends any streak except a `poll` or `invalid` one, a successful poll check ends
a `poll` streak, and a file that loads again ends an `invalid` streak.

`[trigger.onFailure]` (keys also `on_failure`), and `[defaults.onFailure]` in
`pollinate.toml` for the keys a trigger leaves out, decide whether to notify.
Without an action from either, or with `disabled = true`, nothing is sent; a
trigger without either behaves as before. An invalid file has no trigger
config, so only the default applies to it.

- A notification goes out when `consecutiveFailures >= after` (default 1) and
  none went out during this streak in the last `cooldown` (default `1h`). A new
  streak after a recovery notifies again without waiting for the cooldown.
- It is its own job, `source = "failure"`, under the failing trigger's id. It
  tries three times over about 30 s (W3's retry: backoff 10 s then 20 s; it
  retries the action kind's default classes plus `exit` and `timeout`), with
  delivery id `<trigger_id>:failure:<notifiedAt>`. It never counts as a
  failure or success of the trigger and never triggers `onFailure` itself.
- If it cannot be delivered: `pollinate.trigger.on_failure_errored {trigger_id,
  job_id, error, attempts}`. A daemon restart in the middle marks it errored at
  startup (whatever its age), before any trigger fires, and ledgers the same
  event; it is not resumed.
- An undelivered notification does not start the cooldown: `notifiedAt` goes
  back to its value before that notification (it is cleared after a restart),
  so the next failure notifies again.

Poll backoff: after three failed checks in a row the next check waits twice the
interval, doubling per further failure up to 2^16 times the interval; the first
successful check returns to the interval. `pollinate.poll.errored` carries
`consecutive_errors` and `next_check_in_ms`.

Health entries follow the trigger like the other state files (see Lifecycle,
baseline and state cleanup: removal and the startup prune).

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

## Events stream

`GET /v1/events?after=<cursor>&follow=1&tag=&trigger=&types=` on the daemon
socket streams the ledger as `application/x-ndjson` (`src/events.ts`).

- Each ledger line is sent as is, plus `cursor`. A cursor is
  `<generation>-<byte offset>`, the offset just past that line in that
  generation's file. Store the last cursor you processed; pass it as `after`
  to resume with exactly the lines after it. Unparsable lines are skipped.
  A partial line (a writer mid-append) is never sent; it goes out once its
  newline lands.
- Generations: `state/ledger.json` holds `{generation}` (1 when absent).
  `ledger.jsonl` is the current generation, `ledger.jsonl.1` the one before.
  Rotation writes `{generation, rotating: {ino}}` (inode of the file being
  rotated), renames, then writes `{generation: n + 1}`. A reader that finds
  `rotating` decides by whether `ledger.jsonl.1` has that inode, so a crash
  at any step never labels one file with two generations. Readers open a file
  between two generation reads and retry if they differ.
  `pollinate.ledger.rotated` carries the new `generation`.
- No `after`: the stream starts at the current end and first sends
  `{"heartbeat": true, "cursor"}` so a client can store a starting point.
- `after` names a generation that is gone (older than the previous file, newer
  than the current one, or an offset past the file's end): the first line is
  `{"gap": true, "cursor"}` naming the oldest available position, and the
  stream continues from there. A cursor that does not parse, or does not sit at
  a line end, answers 400 `invalid_request`.
- Without `follow`: sends what exists, then a final heartbeat with the end
  cursor (only when `after` was given), and closes. With `follow`: keeps the
  connection open; a heartbeat every 15 s (`POLLINATE_EVENTS_HEARTBEAT_MS`
  overrides it) carries the current cursor, which moves past filtered-out
  lines too. Following uses `fs.watch` on the store directory plus a 1 s
  poll; idle it does a few stats per second and nothing else.
- Rotation while following: the stream finishes the previous file (waiting
  until it has been quiet for 500 ms, so appends that opened it just before
  the rename are included), then moves to the new generation at offset 0.
  A follower more than one rotation behind gets a `gap`.
- Filters, all optional and combined with AND: `trigger=<id>` matches
  `trigger_id`; `types=a,b` matches `event`; `tag=<tag>` matches events whose
  `trigger_id` has that tag. Tags come from the daemon's trigger map, a trigger
  file read for an id it has not seen yet (one added since the last reload),
  and the tags of the last 512 removed triggers, kept in
  `state/trigger-tags.json` so triggers removed while the daemon was down
  still match. Events without `trigger_id` never match `tag` or `trigger`.

## Ledger events

Append-only JSONL at `~/.pollinate/ledger.jsonl`; every entry has `ts` and
`event`. Stream with `pol ledger --follow`.

- `pollinate.trigger.{added,enabled,disabled,removed,delivered,spent}` (see Lifecycle, baseline and state cleanup)
- `pollinate.state.pruned` (per-trigger state removed with its trigger or at startup)
- `pollinate.trigger.invalid` (a trigger file that fails to load, e.g. one
  using a removed action kind; once per file change, keyed on path, mtime and size)
- `pollinate.trigger.{failed,recovered,on_failure_errored}` (see Failure reporting)
- `pollinate.job.{queued,started,completed,errored,cancelled,hive_starting,retry_scheduled,resumed}`
- `pollinate.delivery.{filtered,throttled,duplicate,dropped}`
- `pollinate.schedule.{fired,missed,errored}` · `pollinate.poll.{checked,detected,errored,baselined}`;
  `poll.errored` carries `consecutive_errors` and `next_check_in_ms`
- `pollinate.webhook.{received,rejected,duplicate}`
- `pollinate.hook.{created,delivered,expired,gc_removed}`
- `pollinate.router.{binding_pending,binding_created,binding_routed,binding_closed,binding_errored,binding_retry,binding_expired,binding_reconciled,binding_pruned,already_bound,unbound,open_filtered,open_rate_limited,activity_errored,gc}`
- `pollinate.router.plugin.created` · `pollinate.github.webhook.installed`
- `pollinate.schedule.missed` carries `policy`, `scheduled_at` (first missed
  occurrence), `missed_count`, `detected: "tick" | "startup"` and, past 10,000,
  `missed_count_capped` (see Schedules and missed fires)
- `pollinate.api.errored` (an API call failed with `500 internal`; carries `method`, `path`, `error`)
- `pollinate.daemon.{started,stopped,triggers_reloaded,reload_errored,crash_loop,refused}`;
  `started` carries `socket`, `pid`, `entry` (the real path of the running
  `cli.js`), `commit` and `dirty` (from `dist/build-info.json`; `pol doctor`
  compares them);
  `refused` carries `reason: "locked" | "lock_lost"` and the lock holder's `pid`
  (see One daemon per store)
- `pollinate.jobs.{gc,store_warning}` · `pollinate.ledger.rotated` with `generation` (job/ledger retention, see Job retention and Events stream)
- `pollinate.emit` (from `emit` actions)
- `pollinate.hive.probed {path, version, ok, error?}` (daemon start, when a trigger uses hive; see Action kinds)
- `pollinate.doctor.fixed {fixes}` (`pol doctor --fix` changed something; see Doctor)

## Job IDs

Jobs use Honeybee-style IDs `<TRIGGER-PREFIX>.<uuid-prefix>` (e.g. `HE.a3f`).
`pol job <ref>` accepts the visible id, the suffix, or a longer UUID prefix.
Terminal statuses: `completed`, `errored`, `timed-out`, `cancelled`.
Non-terminal: `queued`, `resolving-context`, `running`, `retrying`.
`Job.source` is the trigger's source kind, `manual`, or `failure` for an
onFailure notification.
