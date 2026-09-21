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

Returns whether an API key is configured and whether browser setup is allowed.

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

Each activity record contains `date`, `userId`, `email`, `displayName`,
`server`, `tool`, and positive integer `usage`. Optional fields are `origin`,
`role`, and `directoryGroups`. Unknown fields are stripped when browser or
snapshot data is parsed.

### `GET /api/mcp/stream`

Uses the same range parameters and result contract. The response content type
is `application/x-ndjson` with one JSON object per line:

- `{ "type": "progress", ... }`: numeric `completed` and `total`, plus `label`
  and `detail`
- `{ "type": "data", "data": ... }`: the final analytics response
- `{ "type": "error", "error": "..." }`: a sanitized terminal error and,
  when setup is required, a `code`

## Errors and limits

JSON routes return `{ "error": "..." }`. A setup-required response also
contains `{ "code": "SETUP_REQUIRED" }`. Upstream bodies and stack traces are
not returned.

The server validates dates, pagination, text lengths, JSON response sizes,
record counts, directory-group counts, membership counts, enriched group
assignments, and estimated analytics response bytes. Optional environment
variables can raise or lower the high default process-safety limits:

- `MAX_MCP_RESPONSE_BYTES`
- `MAX_DIRECTORY_GROUPS`
- `MAX_GROUP_MEMBERSHIPS`
- `MAX_ENRICHED_GROUP_ASSIGNMENTS`

Oversized upstream datasets fail with a sanitized HTTP 502 response.
