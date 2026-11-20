import { describe, expect, it } from "vitest";
import { checkHostname, checkSmtpHost, checkWahaBaseUrl } from "./endpoints.ts";

// Host names are reserved (RFC 2606 / 6761); IP addresses are documentation or private ranges.
describe("WAHA base URL and the private-IP allowlist (plan M3.1, R5)", () => {
  it.each([
    ["https://waha.example.test", "https://waha.example.test/", "waha.example.test"],
    ["https://waha.example.test:3000/api/", "https://waha.example.test:3000/api/", "waha.example.test:3000"],
    ["https://xn--bcher-kva.example/", "https://xn--bcher-kva.example/", "xn--bcher-kva.example"],
  ])("accepts %s", (input, baseUrl, host) => {
    expect(checkWahaBaseUrl(input, false)).toEqual({ ok: true, baseUrl, host });
  });

  it.each(["10.0.0.7", "172.16.5.4", "192.168.1.20", "100.64.0.9"])("a private IPv4 %s needs the explicit allowlist", (ip) => {
    expect(checkWahaBaseUrl(`https://${ip}:3000/`, false)).toEqual({ ok: false, reason: "private_needs_allowlist" });
    expect(checkWahaBaseUrl(`https://${ip}:3000/`, true)).toEqual({ ok: true, baseUrl: `https://${ip}:3000/`, host: `${ip}:3000` });
  });

  // Security review US-017 S3.
  it("the allowlist applies to IPv4 literals only: a host name with it is refused", () => {
    expect(checkWahaBaseUrl("https://waha.example.test/", true)).toEqual({ ok: false, reason: "private_only_for_ip" });
    expect(checkWahaBaseUrl("https://waha.example.test/", false)).toMatchObject({ ok: true });
  });

  it.each(["10.89.51.10", "10.89.52.2", "10.89.0.1", "10.89.255.254"])("the podman networks (%s) stay refused even with the allowlist", (ip) => {
    expect(checkWahaBaseUrl(`https://${ip}/`, true)).toEqual({ ok: false, reason: "blocked_address" });
    expect(checkWahaBaseUrl(`https://${ip}/`, false)).toEqual({ ok: false, reason: "blocked_address" });
  });

  it("neighbours of the podman networks stay allowlistable", () => {
    for (const ip of ["10.88.255.255", "10.90.0.1"]) expect(checkWahaBaseUrl(`https://${ip}/`, true)).toMatchObject({ ok: true });
  });

  it.each([
    ["AWS / GCP / Azure metadata", "169.254.169.254"],
    ["another link-local address", "169.254.10.1"],
    ["Alibaba Cloud metadata (inside CGNAT)", "100.100.100.200"],
    ["loopback", "127.0.0.1"],
    ["this network", "0.0.0.0"],
    ["TEST-NET", "192.0.2.10"],
    ["multicast", "224.0.0.1"],
    ["broadcast", "255.255.255.255"],
  ])("refuses %s (%s) even with the allowlist", (_what, ip) => {
    for (const allow of [false, true]) expect(checkWahaBaseUrl(`https://${ip}/`, allow)).toEqual({ ok: false, reason: "blocked_address" });
  });

  it.each([
    ["the AWS IMDS IPv6 address", "https://[fd00:ec2::254]/"],
    ["an IPv6 ULA", "https://[fd00::7]/"],
    ["IPv6 loopback", "https://[::1]/"],
    ["an IPv4-mapped IPv6", "https://[::ffff:10.0.0.7]/"],
  ])("refuses %s (no IPv6 literals)", (_what, url) => {
    for (const allow of [false, true]) expect(checkWahaBaseUrl(url, allow)).toEqual({ ok: false, reason: "ipv6" });
  });

  it.each([
    ["http", "http://waha.example.test/", "not_https"],
    ["credentials", "https://user:pw@waha.example.test/", "credentials"],
    ["a query", "https://waha.example.test/?x=1", "invalid"],
    ["a fragment", "https://waha.example.test/#x", "invalid"],
    ["upper case", "https://WAHA.example.test/", "invalid"],
    ["an explicit :443", "https://waha.example.test:443/", "invalid"],
    ["an IPv4 shorthand (127.1)", "https://127.1/", "invalid"],
    ["a hex IPv4", "https://0x7f.0.0.1/", "invalid"],
    ["a decimal IPv4", "https://2130706433/", "invalid"],
    ["a trailing dot", "https://waha.example.test./", "invalid"],
    ["percent-encoding in the host", "https://waha%2eexample.test/", "invalid"],
    ["a backslash", "https://waha.example.test\\@evil.example/", "invalid"],
    ["not a URL", "waha.example.test", "invalid"],
  ])("refuses %s", (_what, url, reason) => {
    expect(checkWahaBaseUrl(url, true)).toEqual({ ok: false, reason });
  });
});

describe("SMTP host", () => {
  it("accepts a lowercase host name and, with the allowlist, a private relay", () => {
    expect(checkSmtpHost("smtp.example.test", false)).toEqual({ ok: true, host: "smtp.example.test" });
    expect(checkSmtpHost("10.1.2.3", false)).toEqual({ ok: false, reason: "private_needs_allowlist" });
    expect(checkSmtpHost("10.1.2.3", true)).toEqual({ ok: true, host: "10.1.2.3" });
    expect(checkSmtpHost("smtp.example.test", true)).toEqual({ ok: false, reason: "private_only_for_ip" });
    expect(checkSmtpHost("10.89.51.2", true)).toEqual({ ok: false, reason: "blocked_address" });
  });

  it.each(["smtp.example.test:587", "smtp://smtp.example.test", "SMTP.example.test", "smtp.example.test.", "a b", "", "user@smtp.example.test"])("refuses %s", (input) => {
    expect(checkSmtpHost(input, true)).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses metadata and IPv6 literals", () => {
    expect(checkSmtpHost("169.254.169.254", true)).toEqual({ ok: false, reason: "blocked_address" });
    expect(checkSmtpHost("fd00:ec2::254", true)).toEqual({ ok: false, reason: "ipv6" });
  });
});

describe("checkHostname", () => {
  it("applies the address policy only to IPv4 literals and the stored-form rule to names", () => {
    expect(checkHostname("postback.example.test", false)).toEqual({ ok: true, hostname: "postback.example.test" });
    expect(checkHostname("198.51.100.1", false)).toEqual({ ok: false, reason: "blocked_address" });
    expect(checkHostname("8.8.8.8", false)).toEqual({ ok: true, hostname: "8.8.8.8" });
    expect(checkHostname("localhost", false)).toEqual({ ok: false, reason: "invalid" });
  });
});
