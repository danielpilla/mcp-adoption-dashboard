import { isIP } from "node:net";

export function parsePortValue(value: string, name: string): number {
  const raw = value.trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer from 1 to 65535.`);
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65535.`);
  }
  return port;
}

export function parsePort(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  const raw = value?.trim();
  if (!raw) return fallback;
  return parsePortValue(raw, name);
}

export function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  const raw = value?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return parsed;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const mappedHex = normalized.match(
    /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/,
  );
  const mappedHexStartsWithLoopback =
    mappedHex !== null && Number.parseInt(mappedHex[1] ?? "", 16) >>> 8 === 127;
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    (isIP(normalized) === 4 && normalized.startsWith("127.")) ||
    (mappedIpv4 !== undefined &&
      isIP(mappedIpv4) === 4 &&
      mappedIpv4.startsWith("127.")) ||
    mappedHexStartsWithLoopback
  );
}

export function assertNetworkBindingAllowed(
  host: string,
  allowUnauthenticatedNetwork: boolean,
): void {
  if (isLoopbackHost(host) || allowUnauthenticatedNetwork) return;
  throw new Error(
    "Refusing a non-loopback bind without ALLOW_UNAUTHENTICATED_NETWORK=1. " +
      "Use an authenticating reverse proxy or publish the Docker port only on host loopback.",
  );
}
