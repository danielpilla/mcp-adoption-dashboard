# Architecture

The application has a browser runtime and a server runtime. It persists only
the API key and operator configuration in `.env`; analytics and team metadata
are held in bounded process-local caches. There is no database.

## Component boundaries

```mermaid
flowchart LR
  Entry["src/app/start-dashboard.tsx"] --> Setup["Setup feature"]
  Setup --> Dashboard["Dashboard composition"]
  Dashboard --> Features["Scope, analytics, relationships, pivot, reporting"]
  Dashboard --> Exports["Browser exports"]

  Server["src/server/start-server.ts"] --> Config["Configuration and key persistence"]
  Server --> HTTP["Express HTTP boundary"]
  HTTP --> Cache["Analytics and metadata caches"]
  Cache --> Cursor["Cursor API client"]
  Cursor --> External["Cursor Analytics and Admin APIs"]

  Contracts["src/contracts"] --> Entry
  Contracts --> HTTP
```

Browser behavior belongs in `src/app/<feature>/`. Server behavior belongs in
`src/server/<domain>/`. Both runtimes may import `src/contracts/`, but they do
not import each other's implementation. ESLint enforces those directions.
Focused tests are colocated with their owners; `tests/browser-smoke.test.ts`
exercises the assembled application.

No circular imports were found in the source, script, or test graph.

## Primary request flow

```mermaid
sequenceDiagram
  participant Browser
  participant HTTP as Express server
  participant Cache as Analytics cache
  participant Metadata as Metadata cache
  participant Client as Cursor API client
  participant Analytics as Analytics API
  participant Admin as Admin API

  Browser->>HTTP: GET /api/mcp or /api/mcp/stream
  HTTP->>HTTP: Validate query and client configuration
  HTTP->>Cache: Find or create range entry
  alt Settled or in-flight entry exists
    Cache-->>HTTP: Reuse response promise
  else New range
    par MCP activity
      HTTP->>Client: fetchMcp(range, signal)
      loop Each 30-day window, four at a time
        Client->>Analytics: Fetch paginated MCP activity
        Analytics-->>Client: Validated page
      end
    and Team directory
      HTTP->>Metadata: Load or reuse metadata
      Metadata->>Client: fetchTeamMetadata(signal)
      Client->>Admin: Fetch members, groups, memberships
      Admin-->>Client: Validated directory pages
    end
    Client-->>HTTP: Bounded activity and metadata
    HTTP->>HTTP: Enrich, summarize, and reconcile
    HTTP->>Cache: Store settled response for 12 hours
  end
  HTTP-->>Browser: JSON or NDJSON progress and data
  Browser->>Browser: Validate, filter, and render in memory
```

Matching requests share one promise. The server aborts upstream work when all
subscribers disconnect, a newer API key supersedes the client, the five-minute
deadline expires, or the process shuts down. The Refresh action invalidates
settled data for one range and is rate-limited to once per 10 seconds.

## Configuration lifecycle

```mermaid
stateDiagram-v2
  [*] --> Unconfigured: No API key
  Unconfigured --> Validating: Browser setup or startup key
  Validating --> Ready: Cursor validation succeeds
  Validating --> Unconfigured: Cursor returns 401 or 403
  Validating --> Deferred: Startup validation has a transient failure
  Deferred --> Ready: A data request succeeds
  Deferred --> Unconfigured: Cursor returns 401 or 403
  Ready --> Validating: API key rotation
  Ready --> Unconfigured: Cursor later returns 401 or 403
```

Browser setup and key rotation are enabled only when the process binds to a
loopback interface. A non-loopback bind requires the explicit
`ALLOW_UNAUTHENTICATED_NETWORK=1` acknowledgement and still needs an
authenticating reverse proxy.

## In-memory response model

The ER diagram describes the validated wire contract, not database tables.

```mermaid
erDiagram
  MCP_RESPONSE ||--|| DATE_RANGE : covers
  MCP_RESPONSE ||--o{ MCP_RECORD : contains
  MCP_RESPONSE o|--|| TEAM_SUMMARY : includes

  MCP_RESPONSE {
    string generatedAt
    string source
  }
  DATE_RANGE {
    string startDate
    string endDate
  }
  MCP_RECORD {
    string date
    string userId
    string email
    string displayName
    string server
    string tool
    int usage
    string origin
    string role
    string directoryGroups
  }
  TEAM_SUMMARY {
    string id
    string name
    int memberCount
    int groupCount
  }
```

Each record represents positive usage for one user, UTC date, MCP label, and
tool. `src/contracts/mcp-response.ts` strips unknown fields, validates every
known field, verifies that dates fall inside the inclusive range, and
recomputes the summary before browser code accepts a response.

## Build and deployment

Vite builds the React application into one self-contained `dist/index.html`.
TypeScript compiles the NodeNext server to `dist-server/`; `npm start` serves
the API and built single-page application from the same Express process.

The Dockerfile repeats that build in a pinned Node.js image, installs only
runtime dependencies in the final stage, runs as the unprivileged `node` user,
and checks `/api/health`. CI runs the repository gate on supported Node.js 20,
22, and 24 releases, then separately verifies the browser flow and container.

## External integrations

- Cursor Analytics API supplies per-user MCP activity. Date ranges are split
  into 30-day windows, fetched with bounded concurrency, paginated, and merged.
- Cursor Admin API supplies team members, directory groups, and memberships.
  Requests are client-throttled and results are cached.
- No telemetry, database, object store, or third-party authentication service
  is used.

Upstream payloads are untrusted. The client limits body bytes, page count,
records, directory groups, memberships, text lengths, retries, and time. The
HTTP boundary maps upstream details to sanitized errors and never returns the
API key.
