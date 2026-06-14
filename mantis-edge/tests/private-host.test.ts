import { describe, expect, it } from "vitest";
import { isPrivateLiteralHost } from "../src/private-host";

describe("isPrivateLiteralHost", () => {
  it.each([
    ["169.254.169.254", true], // cloud metadata
    ["127.0.0.1", true],
    ["10.1.2.3", true],
    ["172.16.0.1", true],
    ["172.32.0.1", false], // outside RFC1918
    ["192.168.1.1", true],
    ["100.64.0.1", true], // CGNAT
    ["192.88.99.1", true], // 6to4 relay
    ["198.18.0.1", true], // benchmarking
    ["0.0.0.0", true],
    ["224.0.0.1", true], // multicast
    ["8.8.8.8", false],
    ["93.184.216.34", false],
    ["[::1]", true], // bracketed loopback
    ["::1", true],
    ["fe80::1", true],
    ["fc00::1", true],
    ["fd12::1", true],
    ["::ffff:127.0.0.1", true], // IPv4-mapped loopback (dotted)
    ["::ffff:a9fe:a9fe", true], // hex IPv4-mapped metadata — was a bypass
    ["[::ffff:a9fe:a9fe]", true], // bracketed, as new URL().hostname yields it
    ["::ffff:7f00:1", true], // hex IPv4-mapped loopback — was a bypass
    ["64:ff9b::a9fe:a9fe", true], // NAT64 well-known → metadata
    ["64:ff9b::8.8.8.8", false], // NAT64 → public
    ["2002:7f00:1::", true], // 6to4 → loopback
    ["2002:0808:0808::", false], // 6to4 → public 8.8.8.8
    ["2606:4700:4700::1111", false], // public
    ["example.com", false], // hostname — not a literal IP
    ["webhook.internal", false], // hostname — can't resolve at the edge
  ])("isPrivateLiteralHost(%j) → %j", (host, expected) => {
    expect(isPrivateLiteralHost(host)).toBe(expected);
  });
});
