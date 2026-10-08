# HTTP API contract

The HTTP API is an internal backend-for-frontend contract used by the bundled
dashboard. It has no application authentication. Keep it on loopback or behind
an authenticating reverse proxy.

Every `/api` response includes `Cache-Control: private, no-store`. All server
responses also set a restrictive content security policy, same-origin
cross-origin policies, disabled camera/geolocation/microphone permissions, and
standard MIME-sniffing, referrer, and framing protections.

## Health and setup

### `GET /api/health`

Returns HTTP 200 while the process is alive:

```json
{ "ok": true, "configured": false }
```

### `GET /api/ready` and `GET /api/health/ready`

Returns HTTP 200 when a validated Cursor client is ready and HTTP 503
otherwise. In this response, `configured` means ready for analytics requests.
The liveness endpoint reports whether a client is present, so a key whose
startup validation was deferred can temporarily produce `configured: true` on
`/api/health` and `configured: false` here.

### `GET /api/setup/status`

Returns whether an API key is configured, whether browser setup is allowed,
the range in days pre-selected at startup when none is remembered
(`DEFAULT_RANGE_DAYS`, default `90`), the remembered startup range, and the
coverage of the per-day activity cache:

```json
{
  "configured": true,
  "setupAllowed": true,
  "defaultRangeDays": 90,
  "rangePreference": { "kind": "preset", "days": 180 },
  "cacheCoverage": {
    "firstDate": "2026-03-01",
    "lastDate": "2026-09-17",
    "days": 201,
    "cacheableThrough": "2026-09-17",
    "spans": [{ "startDate": "2026-03-01", "endDate": "2026-09-17" }]
  }
}
```

`rangePreference` is `{ "kind": "preset", "days": n }` (a rolling range ending
today), `{ "kind": "custom", "startDate": "...", "endDate": "..." }`, or `null`
when nothing is remembered or it cannot be read. `cacheCoverage` is computed
from the cache index without reading any day file; it is `null` when the server
has no day cache. `spans` lists contiguous cached days, oldest first, and keeps
only the newest 400 runs. `cacheableThrough` is the newest day that can be
cached; later days are always refetched.

### `PUT /api/setup/range`

Remembers the startup range. The body is a `rangePreference` value: a preset of
1 to 366 days or a custom range of at most 366 days. Unknown fields are
dropped. Returns HTTP 200 with `{ "rangePreference": ... }`, HTTP 400 for an
invalid range, or HTTP 503 when the server cannot store it. The range is
written atomically, with owner-only permissions, to `startup-range.json` in
`MCP_CACHE_DIR`.

### `POST /api/setup`

Accepts `{ "apiKey": "..." }` only on loopback deployments. Returns HTTP 201
after validation and persistence. Existing configurations return HTTP 409.

### `POST /api/settings/api-key`

Validates and replaces an existing API key on loopback deployments.

## Analytics

### `GET /api/mcp`

Required query parameters:

- `startDate`: UTC `YYYY-MM-DD`
- `endDate`: UTC `YYYY-MM-DD`

Optional query parameter:

- `refresh=1`: bypasses settled analytics and metadata caches; repeated
  refreshes of one range within 10 seconds return HTTP 429.

The inclusive range cannot exceed 366 days or end in the future.

Successful responses contain:

- `records`: validated per-user, per-day, per-MCP, per-tool activity
- `summary`: totals reconciled against `records`
- `range`: the requested range
- `generatedAt`: ISO timestamp
- `source`: `live` or `snapshot`
- optional `team`: team ID, display name, member count, and group count
- optional `notices`: non-blocking conditions, described below

Each activity record contains `date`, `userId`, `email`, `displayName`,
`server`, `tool`, and positive integer `usage`. Optional fields are `origin`,
`role`, and `directoryGroups`. Unknown fields are stripped when browser or
snapshot data is parsed.

Each notice contains `code` and `message`, plus optional `setting`, `limit`,
and `completeFrom`:

- `LIMIT_REACHED`: a cap or timeout stopped loading early, and the response is
  partial. `setting` names the environment variable to raise. When
  `completeFrom` is present, activity from that date through `endDate` is
  complete; earlier days are partial or missing. The newest days are always
  kept first.
- `DIRECTORY_LOADING`: directory groups are still loading in the background.
  Activity is complete, but names, roles, and groups are not attached yet.
- `DIRECTORY_UNAVAILABLE`: the directory could not be loaded. Activity is
  complete without names, roles, and groups.

The JSON body is written incrementally, so a large result is never held as one
string on the server.

### `GET /api/mcp/stream`

Uses the same range parameters and result contract. The response content type
is `application/x-ndjson` with one JSON object per line:

- `{ "type": "progress", ... }`: numeric `completed` and `total`, plus `label`,
  `detail`, `directory` (`status`, `completedGroups`, and `totalGroups`,
  which is `null` until known), and `activity`:
  - `state`: `loading`, `reused` (a settled result is reused), or `ready`
  - `totalDays`, `cachedDays`, and `fetchedDays`: days in the range, days
    served from the day cache, and days in fetch windows that finished
  - `records`: activity rows loaded so far
  - `completedWindows` and `totalWindows`: 30-day fetch windows
  - `windows`: running windows, newest first, each with `startDate`,
    `endDate`, `days`, `pagesLoaded`, and `totalPages` (`null` until known)
  - `retry`: `null`, or `attempt`, `maxAttempts`, `delayMs`, `waitedMs`,
    `reason` (`rate_limited`, `server_error`, or `network_error`), and
    `status` (`null` after a network error) while a request waits to be
    retried
  - `elapsedMs` since the load started, and `idleMs` since the last page or
    window finished
- `{ "type": "records", "records": [...] }`: a batch of up to 5,000 activity
  records, in ascending date order
- `{ "type": "data", "data": ... }`: the final analytics response without
  `records`; clients append the batches in order
- `{ "type": "error", "error": "..." }`: a sanitized terminal error and,
  when setup is required, a `code`

Optional query parameter `refresh=1` behaves as it does for `GET /api/mcp`.

### `GET /api/directory/status`

Returns the state of the background directory load:

```json
{ "status": "loading", "completedGroups": 120, "totalGroups": 400 }
```

`status` is `disabled`, `idle`, `loading`, `ready`, or `failed`. `totalGroups`
is `null` until the number of groups is known.

## Errors and limits

JSON routes return `{ "error": "..." }`. A setup-required response also
contains `{ "code": "SETUP_REQUIRED" }`. Upstream bodies and stack traces are
not returned.

The server validates dates, pagination, text lengths, and JSON structure. These
optional environment variables cap work per request; their defaults are high
enough that they are not reached in normal use:

- `MAX_MCP_RECORDS`
- `MAX_MCP_RESPONSE_BYTES`
- `MAX_API_PAGE_BYTES`
- `MAX_DIRECTORY_GROUPS`
- `MAX_GROUP_MEMBERSHIPS`
- `MAX_ENRICHED_GROUP_ASSIGNMENTS`
- `ANALYTICS_TIMEOUT_MS`
- `DIRECTORY_LOAD_TIMEOUT_MS`

Reaching a cap returns HTTP 200 with the data loaded so far and a
`LIMIT_REACHED` notice; it never fails the request or stops the server.
Malformed upstream data still fails with a sanitized HTTP 502 response.
