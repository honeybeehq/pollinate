# Pollinate local API v1

The daemon serves HTTP/1.1 + JSON on a Unix socket. There is no TCP listener
and no token: whoever can open the socket (mode `0600`, inside the store
directory) is trusted, the same as whoever can write the store.

- Socket: `<store>/pollinated.sock`; `POLLINATE_SOCKET` overrides the path.
  A path over 103 bytes (the macOS `sun_path` limit) refuses the start.
- Prefix: `/v1`. Changes inside v1 are additive only.
- Ready test: `GET /v1/health` answers once schedules, polls and webhooks run.
- Writes made through the API reach the engines before the answer. Writes made
  to trigger files are still picked up by the 1 s file reload.
- `pol add`, `remove`, `enable`, `disable`, `trigger` and `job cancel` use this
  API when the daemon answers and fall back to files only when it cannot be
  reached or answers `503`/`501` (see Local API in AGENTS.md).

```sh
curl -s --unix-socket ~/.pollinate/pollinated.sock http://pollinate/v1/health
```

## Errors

Every error answers `{"error": {"code", "message", "details"?}}`.

| code | HTTP | when |
|---|---|---|
| `invalid_trigger` | 400 | the trigger body does not parse or validate, or its id differs from the path id |
| `invalid_request` | 400 | the body is not a JSON object, or a query parameter or field is malformed |
| `not_found` | 404 | no such trigger, job or route |
| `conflict` | 409 | `ifAbsent=1` on an existing id; a duplicate `deliveryId`; firing a disabled trigger; an ambiguous job reference |
| `poll_failed` | 422 | a poll trigger's first check failed inside `PUT`; nothing was stored |
| `unsupported` | 501 | a call this build does not serve (`/v1/events`, `/v1/doctor`); 405 for a wrong method on a known path |
| `stopping` | 503 | the daemon is shutting down |
| `internal` | 500 | anything else; also ledgered as `pollinate.api.errored` |

## Calls

### `GET /v1/health`

```json
{"name":"pollinate","version":"1.0.0","commit":"e8676a50a1415f7c6ea34e229910bef6dd8e240f","api":1,
 "features":["retry","baseline","onFailure"],"pid":45937,
 "startedAt":"2026-11-25T11:54:48.261Z","reloadedAt":"2026-11-25T11:54:48.261Z",
 "store":"/tmp/pol-HLr6","triggers":{"total":0,"enabled":0},
 "webhook":{"bind":"127.0.0.1","port":39871,"publicUrl":null},
 "hive":{"path":"/Users/me/.local/bin/hive","version":"honeybee 0.0.1"}}
```

`version` and `commit` come from `dist/build-info.json`, as in
`pol --version --json`. `features` lists what this build supports; a client
checks it instead of the version. `reloadedAt` is the last time the engines
took a new trigger set (API write or file reload). `hive` appears once the
daemon has found `hive` on `PATH`; it looks on the first health call, so the
first answer may omit it and `version` may be `null` for a moment.

### `PUT /v1/triggers/:id`

Body is `{"toml": "<trigger TOML>"}` or `{"trigger": {...}}` (the `[trigger]`
table as JSON; camelCase and snake_case keys both work). A missing id takes the
path id; a different id is `invalid_trigger`. `?ifAbsent=1` answers 409 instead
of overwriting.

```json
PUT /v1/triggers/inbox
{"toml":"[trigger]\nid = \"inbox\"\n[trigger.source]\nkind = \"webhook\"\n[trigger.source.webhook]\npath = \"inbox\"\n[trigger.action]\nkind = \"emit\"\nsubject = \"demo.inbox\"\n"}

200 {"trigger":{"id":"inbox",...},"created":true,"loaded":true,
     "webhook":{"path":"/hook/inbox","url":"http://127.0.0.1:39871/hook/inbox","localUrl":"http://127.0.0.1:39871/hook/inbox"}}
```

The answer comes after the engines hold the trigger, so a POST to
`webhook.url` right after it is accepted. `url` uses `[webhook] publicUrl`
when set, else equals `localUrl`.

A schedule answers its next fire time:

```json
PUT /v1/triggers/tick?ifAbsent=1
{"trigger":{"id":"tick","source":{"kind":"schedule","timing":{"type":"every","interval":"15m"}},"action":{"kind":"emit","subject":"demo.tick"}}}

200 {"trigger":{...},"created":true,"loaded":true,"schedule":{"nextFireAt":"2026-11-25T12:10:06.925Z"}}
```

An enabled poll runs its first check inside the call. With `baseline = true`
the answer is `poll.baseline.items` (items recorded, nothing fired); without
it, `poll.checked: {items, new}` (new items were dispatched as usual).

```json
PUT /v1/triggers/feed
{"trigger":{"id":"feed","source":{"kind":"poll","poll":{"interval":"1m","baseline":true,"fetch":{"kind":"file","path":"/tmp/feed.json"},"cursor":{"strategy":"jsonpath","jsonpath":"$[*].id"}}},"action":{"kind":"emit","subject":"demo.feed"}}}

200 {"trigger":{...},"created":true,"loaded":true,"poll":{"baseline":{"items":3}}}
```

If the first check fails (fetch error, timeout, unparseable output), nothing
is stored:

```json
422 {"error":{"code":"poll_failed","message":"first poll check failed: poll command exited 3: nope","details":{"id":"broken","error":"poll command exited 3: nope"}}}
```

The check is bounded by the poll's `interval`, like any poll.

### `GET /v1/triggers?tag=&source=&enabled=` and `GET /v1/triggers/:id`

All filters are optional; `source` is `schedule|poll|webhook|manual`,
`enabled` is `1|0|true|false`. Each trigger carries `state`:

```json
GET /v1/triggers/inbox

200 {"trigger":{"id":"inbox",...,"state":{"nextFireAt":null,"lastFireAt":null,
     "lastJob":{"id":"IN.699","status":"completed","error":null},"consecutiveFailures":0,"deliveries":0}}}

GET /v1/triggers?tag=apiary
200 {"triggers":[{...,"state":{...}}, ...]}
```

`nextFireAt` is `null` unless the trigger is an enabled schedule.
`deliveries` is the lifecycle delivery count. `consecutiveFailures` is the
trigger health streak (see Failure reporting in AGENTS.md).

### `PATCH /v1/triggers/:id`

```json
PATCH /v1/triggers/tick
{"enabled":false}

200 {"trigger":{"id":"tick","enabled":false,...,"state":{"nextFireAt":null,...}}}
```

### `DELETE /v1/triggers/:id`

Removes the file and the trigger's state entries, then the engines drop it.

```json
DELETE /v1/triggers/tick
200 {"removed":"tick"}
```

### `POST /v1/triggers/:id/fire`

Fires through the daemon's delivery queue, so `maxConcurrent`, the delivery
mode, filters, lifecycle counting and dedup all hold. With `deliveryId` the
activation's delivery id is `<trigger>:<deliveryId>` and a repeat answers 409.

```json
POST /v1/triggers/man/fire
{"payload":{"n":1},"deliveryId":"d-1"}

200 {"job":{"id":"MA.451","triggerId":"man","deliveryId":"man:d-1","status":"queued","source":"manual",...}}

POST /v1/triggers/man/fire  (same deliveryId)
409 {"error":{"code":"conflict","message":"delivery d-1 was already fired; not firing again","details":{"id":"man","reason":"duplicate","deliveryId":"d-1"}}}
```

`job` is `null` when delivery took the activation without creating a job
yet (throttled, batched or debounced modes, a filter miss, a full queue).

### `GET /v1/jobs?trigger=&status=&limit=`

Newest first. `limit` defaults to 50, at most 1000.

```json
GET /v1/jobs?trigger=man&limit=10
200 {"jobs":[{"id":"MA.b67","status":"queued",...},{"id":"MA.451","status":"running",...}]}
```

### `GET /v1/jobs/:id`

Accepts the same references as `pol job` (visible id, suffix, UUID prefix).

```json
GET /v1/jobs/MA.b67
200 {"job":{"id":"MA.b67","triggerId":"man","status":"queued",...}}
```

### `POST /v1/jobs/:id/cancel`

Same as `pol job cancel`; a terminal job is returned unchanged.

```json
POST /v1/jobs/MA.b67/cancel
200 {"job":{"id":"MA.b67","status":"cancelled","error":"Cancelled before start (cancelled via API)",...}}
```

### `GET /v1/events`

Not served by this build:

```json
501 {"error":{"code":"unsupported","message":"GET /v1/events is not available in this build"}}
```

### `GET /v1/doctor`

Not served by this build (`501 unsupported`).
