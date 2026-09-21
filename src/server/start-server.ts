import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CursorApiClient,
  DEFAULT_CURSOR_API_LIMITS,
} from "./cursor/cursor-api.js";
import { createApp } from "./http/http-server.js";
import {
  assertNetworkBindingAllowed,
  isLoopbackHost,
  parsePort,
  parsePositiveInteger,
} from "./configuration/server-configuration.js";
import {
  validateSavedClient,
  writeSetupEnv,
} from "./configuration/api-key-setup.js";
import { configureInternalMcpServers } from "../contracts/mcp-origin.js";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const apiKey = process.env.CURSOR_API_KEY?.trim();
const port = parsePort(process.env.SERVER_PORT, 4173, "SERVER_PORT");
const teamName = process.env.CURSOR_TEAM_NAME?.trim() ?? "";
const cursorApiLimits = {
  maxResponseBytes: parsePositiveInteger(
    process.env.MAX_MCP_RESPONSE_BYTES,
    DEFAULT_CURSOR_API_LIMITS.maxResponseBytes,
    "MAX_MCP_RESPONSE_BYTES",
  ),
  maxDirectoryGroups: parsePositiveInteger(
    process.env.MAX_DIRECTORY_GROUPS,
    DEFAULT_CURSOR_API_LIMITS.maxDirectoryGroups,
    "MAX_DIRECTORY_GROUPS",
  ),
  maxGroupMemberships: parsePositiveInteger(
    process.env.MAX_GROUP_MEMBERSHIPS,
    DEFAULT_CURSOR_API_LIMITS.maxGroupMemberships,
    "MAX_GROUP_MEMBERSHIPS",
  ),
};
const maxEnrichedGroupAssignments = parsePositiveInteger(
  process.env.MAX_ENRICHED_GROUP_ASSIGNMENTS,
  DEFAULT_CURSOR_API_LIMITS.maxEnrichedGroupAssignments,
  "MAX_ENRICHED_GROUP_ASSIGNMENTS",
);
configureInternalMcpServers(process.env.INTERNAL_MCP_SERVERS);
const staticDir = fileURLToPath(new URL("../../dist", import.meta.url));
const host = process.env.BIND_HOST?.trim() || "127.0.0.1";
const setupAllowed = isLoopbackHost(host);
const networkBindingAllowed =
  process.env.ALLOW_UNAUTHENTICATED_NETWORK?.trim() === "1";
assertNetworkBindingAllowed(host, networkBindingAllowed);
const createClient = (key: string) =>
  new CursorApiClient(
    key,
    undefined,
    undefined,
    undefined,
    teamName,
    undefined,
    cursorApiLimits,
  );
const VALIDATION_TIMEOUT_MS = 5 * 60_000;

const client = apiKey ? createClient(apiKey) : undefined;
const shutdownController = new AbortController();
const validationSignal = () =>
  AbortSignal.any([
    shutdownController.signal,
    AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
  ]);
const initialClientValidation = client
  ? validateSavedClient(client, validationSignal())
  : undefined;

const app = createApp({
  client,
  initialClientValidation,
  setup: {
    allowed: setupAllowed,
    configure: async (key, signal) => {
      const candidate = createClient(key);
      const metadata = await candidate.fetchTeamMetadata(
        signal
          ? AbortSignal.any([signal, validationSignal()])
          : validationSignal(),
      );
      return { client: candidate, metadata };
    },
    persist: (key) => writeSetupEnv(resolve(".env"), key),
  },
  staticDir,
  teamName,
  maxEnrichedGroupAssignments,
  shutdownSignal: shutdownController.signal,
});

/*
 * Loopback by default. Every endpoint here is unauthenticated, and /api/mcp
 * returns named per-person adoption records including emails and group
 * membership. Binding to all interfaces by default would put that on the
 * network for anyone who can route to the host.
 *
 * A non-loopback BIND_HOST also requires ALLOW_UNAUTHENTICATED_NETWORK=1.
 * Put an authenticating reverse proxy in front when exposing it. The container
 * binds its internal network explicitly so Docker port publishing can reach
 * the process; publishing a port does not add access control.
 */
const server = app.listen(port, host, () => {
  console.log(
    `Cursor MCP Adoption Dashboard running at http://${host}:${port}`,
  );
  if (!client) {
    console.log(
      setupAllowed
        ? "Open the dashboard to configure a Cursor Team Admin API key."
        : "Run `npm run init` on the server to configure a Cursor Team Admin API key.",
    );
  }
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        event: "listen.exposed",
        host,
        reason:
          "Bound beyond loopback with no authentication on any route. Require an authenticating proxy in front of this process.",
      }),
    );
  }
});

void initialClientValidation?.then((validation) => {
  if (validation.status === "valid") {
    console.log("Validated saved Cursor API key.");
  } else if (validation.status === "invalid") {
    console.warn(
      "The saved Cursor API key is invalid. Dashboard setup is required.",
    );
  } else {
    console.warn(
      "Could not validate the saved Cursor API key. Readiness will remain false until a data request succeeds.",
    );
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shutdownController.signal.aborted) return;
    shutdownController.abort(
      new DOMException(`Received ${signal}`, "AbortError"),
    );
    server.closeIdleConnections();
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      process.exit(1);
    }, 10_000);
    deadline.unref();
    server.close(() => {
      clearTimeout(deadline);
      process.exit(0);
    });
  });
}
