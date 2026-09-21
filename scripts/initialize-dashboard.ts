import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertNetworkBindingAllowed,
  parsePortValue,
} from "../src/server/configuration/server-configuration.js";
import {
  CursorApiClient,
  CursorApiError,
} from "../src/server/cursor/cursor-api.js";
import {
  renderEnv,
  renderEnvWithApiKey,
  writeSetupEnv,
} from "../src/server/configuration/api-key-setup.js";

export { renderEnv, renderEnvWithApiKey };

const ENV_PATH = resolve(".env");
const VALIDATION_TIMEOUT_MS = 5 * 60_000;
const SECURE_PROMPT_ERROR =
  "Secure hidden input requires an interactive TTY. Set CURSOR_API_KEY in a protected environment file (for example, a mode-600 .env) instead. Do not pass the key in command arguments or pipe or echo it into this command.";

class SetupCancelledError extends Error {}

export type InitOptions = {
  port?: number;
  serverPort?: number;
  teamName?: string;
  bindHost?: string;
  allowUnauthenticatedNetwork?: boolean;
  help?: boolean;
};

function optionValue(
  args: string[],
  index: number,
  inlineValue: string | undefined,
  name: string,
): { value: string; nextIndex: number } {
  const value = inlineValue ?? args[index + 1];
  if (value === undefined || (!inlineValue && value.startsWith("--"))) {
    throw new Error(`${name} requires a value.`);
  }
  return { value, nextIndex: inlineValue === undefined ? index + 1 : index };
}

function parseSingleLineValue(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || /[\r\n\0]/.test(normalized)) {
    throw new Error(`${name} must be a non-empty single-line value.`);
  }
  return normalized;
}

export function parseInitArgs(args: string[]): InitOptions {
  const options: InitOptions = {};

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const separator = argument.indexOf("=");
    const name = separator === -1 ? argument : argument.slice(0, separator);
    const inlineValue =
      separator === -1 ? undefined : argument.slice(separator + 1);

    if (name === "--help" || name === "-h") {
      options.help = true;
      continue;
    }
    if (name === "--api-key") {
      throw new Error(
        "For security, do not pass the API key as an argument. Run `npm run init` and paste it at the hidden prompt.",
      );
    }
    if (name === "--allow-unauthenticated-network") {
      if (inlineValue !== undefined) {
        throw new Error(`${name} does not accept a value.`);
      }
      options.allowUnauthenticatedNetwork = true;
      continue;
    }
    if (
      ![
        "--port",
        "--server-port",
        "--team-name",
        "--bind-host",
        "--host",
      ].includes(name)
    ) {
      throw new Error(
        `Unknown option: ${name}. Run \`npm run init -- --help\`.`,
      );
    }

    const parsed = optionValue(args, index, inlineValue, name);
    index = parsed.nextIndex;
    if (name === "--port") {
      options.port = parsePortValue(parsed.value, name);
    } else if (name === "--server-port") {
      options.serverPort = parsePortValue(parsed.value, name);
    } else if (name === "--team-name") {
      options.teamName = parseSingleLineValue(parsed.value, name);
    } else if (name === "--bind-host" || name === "--host") {
      options.bindHost = parseSingleLineValue(parsed.value, name);
    }
  }

  if (options.bindHost) {
    assertNetworkBindingAllowed(
      options.bindHost,
      options.allowUnauthenticatedNetwork === true,
    );
  }
  return options;
}

export const INIT_HELP = `Usage: npm run init -- [options]

Options:
  --port <number>        Browser-facing development UI port (default: 5173)
  --server-port <number> Node API and production server port (default: 4173)
  --team-name <name>     Team name displayed in the dashboard
  --bind-host <host>     Interface for the local server (default: 127.0.0.1)
  --allow-unauthenticated-network
                        Acknowledge that a non-loopback bind requires external authentication
  -h, --help             Show this help

The Team Admin API key is always entered at a hidden interactive prompt.
For non-interactive setup, place CURSOR_API_KEY in a protected environment
file such as a mode-600 .env. Never pass or echo the key in command arguments.`;

export async function writeApiKeyEnv(
  path: string,
  apiKey: string,
  options: InitOptions = {},
): Promise<void> {
  const updates: Record<string, string> = {};
  if (options.port !== undefined) updates.PORT = String(options.port);
  if (options.serverPort !== undefined) {
    updates.SERVER_PORT = String(options.serverPort);
  }
  if (options.teamName !== undefined) {
    updates.CURSOR_TEAM_NAME = options.teamName;
  }
  if (options.bindHost !== undefined) updates.BIND_HOST = options.bindHost;
  if (options.allowUnauthenticatedNetwork) {
    updates.ALLOW_UNAUTHENTICATED_NETWORK = "1";
  }

  await writeSetupEnv(path, apiKey, updates);
}

export async function promptSecret(
  label: string,
  input = process.stdin,
  output = process.stdout,
): Promise<string> {
  if (!input.isTTY || !output.isTTY || !input.setRawMode) {
    throw new Error(SECURE_PROMPT_ERROR);
  }

  const wasRaw = input.isRaw;
  input.setEncoding("utf8");
  try {
    input.setRawMode(true);
  } catch {
    throw new Error(SECURE_PROMPT_ERROR);
  }
  output.write(label);
  input.resume();

  return new Promise((resolvePrompt, rejectPrompt) => {
    let value = "";

    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
    };

    const onData = (chunk: string | Buffer) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") {
          cleanup();
          output.write("\n");
          rejectPrompt(new SetupCancelledError("Setup cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          output.write("\n");
          resolvePrompt(value.trim());
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value) {
            value = [...value].slice(0, -1).join("");
            output.write("\b \b");
          }
          continue;
        }
        if (character >= " " && character !== "\u001b") {
          value += character;
          output.write("*");
        }
      }
    };

    input.on("data", onData);
  });
}

export async function runInit(args = process.argv.slice(2)): Promise<void> {
  const options = parseInitArgs(args);
  if (options.help) {
    console.log(INIT_HELP);
    return;
  }
  console.log("\nCursor MCP Adoption Dashboard setup\n");
  const apiKey = await promptSecret("Cursor Team Admin API key: ");
  if (!apiKey) throw new Error("An API key is required.");

  console.log("Validating access with Cursor...");
  const metadata = await new CursorApiClient(apiKey).fetchTeamMetadata(
    AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
  );
  await writeApiKeyEnv(ENV_PATH, apiKey, options);

  console.log(
    `Connected successfully: ${metadata.memberCount} members and ${metadata.groupNames.length} groups.`,
  );
  console.log("Saved .env with owner-only permissions.");
  if (options.port !== undefined) {
    console.log(`Development UI port: ${options.port}`);
  }
  if (options.serverPort !== undefined) {
    console.log(`API/production server port: ${options.serverPort}`);
  }
  if (options.bindHost !== undefined) {
    console.log(`Bind host: ${options.bindHost}`);
  }
  console.log("\nSetup complete. Run `npm run dev` to start the dashboard.\n");
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  runInit().catch((error: unknown) => {
    if (error instanceof CursorApiError && [401, 403].includes(error.status)) {
      console.error(
        "Cursor rejected this key. Create a Team Admin API key with Analytics access and try again.",
      );
    } else if (error instanceof DOMException && error.name === "TimeoutError") {
      console.error(
        "Cursor API validation timed out after five minutes. Check network access and try again.",
      );
    } else {
      console.error(error instanceof Error ? error.message : "Setup failed.");
    }
    process.exitCode = 1;
  });
}
