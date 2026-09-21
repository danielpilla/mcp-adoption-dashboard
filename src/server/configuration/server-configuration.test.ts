import { describe, expect, it } from "vitest";
import {
  assertNetworkBindingAllowed,
  isLoopbackHost,
  parsePort,
  parsePortValue,
  parsePositiveInteger,
} from "./server-configuration";

describe("server configuration", () => {
  it("uses the fallback when a port is not configured", () => {
    expect(parsePort(undefined, 4173, "SERVER_PORT")).toBe(4173);
    expect(parsePort(" ", 4173, "SERVER_PORT")).toBe(4173);
  });

  it("accepts valid TCP ports", () => {
    expect(parsePort("1", 4173, "SERVER_PORT")).toBe(1);
    expect(parsePort("65535", 4173, "SERVER_PORT")).toBe(65_535);
  });

  it.each(["0", "65536", "4173.5", "not-a-port", "-1"])(
    "rejects invalid port %s",
    (value) => {
      expect(() => parsePort(value, 4173, "SERVER_PORT")).toThrow(
        "SERVER_PORT must be an integer from 1 to 65535.",
      );
    },
  );

  it("applies the same validation to required port values", () => {
    expect(parsePortValue(" 4173 ", "--server-port")).toBe(4173);
    expect(() => parsePortValue("", "--server-port")).toThrow(
      "--server-port must be an integer from 1 to 65535.",
    );
    expect(() => parsePortValue("9007199254740992", "--server-port")).toThrow(
      "--server-port must be an integer from 1 to 65535.",
    );
  });

  it("parses positive safety limits", () => {
    expect(parsePositiveInteger(undefined, 100, "LIMIT")).toBe(100);
    expect(parsePositiveInteger(" 250000 ", 100, "LIMIT")).toBe(250_000);
    for (const invalid of ["0", "-1", "1.5", "not-a-number"]) {
      expect(() => parsePositiveInteger(invalid, 100, "LIMIT")).toThrow(
        "LIMIT must be a positive safe integer.",
      );
    }
  });

  it("recognizes supported loopback host names", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.42.0.9")).toBe(true);
    expect(isLoopbackHost(" LOCALHOST ")).toBe(true);
    expect(isLoopbackHost("dashboard.localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackHost("[::ffff:7f00:1]")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("::ffff:192.168.0.1")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.example.com")).toBe(false);
  });

  it("requires explicit acknowledgement for a non-loopback bind", () => {
    expect(() => assertNetworkBindingAllowed("127.0.0.1", false)).not.toThrow();
    expect(() =>
      assertNetworkBindingAllowed("127.42.0.9", false),
    ).not.toThrow();
    expect(() =>
      assertNetworkBindingAllowed("dashboard.localhost", false),
    ).not.toThrow();
    expect(() => assertNetworkBindingAllowed("0.0.0.0", true)).not.toThrow();
    expect(() => assertNetworkBindingAllowed("0.0.0.0", false)).toThrow(
      "ALLOW_UNAUTHENTICATED_NETWORK=1",
    );
  });
});
