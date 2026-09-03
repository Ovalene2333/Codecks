import test from "node:test";
import assert from "node:assert/strict";
import {
  detectIpv6,
  detectPublicIpv4,
  syncDdns,
} from "./ddns.js";

function ipv6Interface(address: string, internal = false) {
  return {
    address,
    netmask: "ffff:ffff:ffff:ffff::",
    family: "IPv6" as const,
    mac: "",
    internal,
    scopeid: 0,
    cidr: `${address}/64`,
  };
}

test("detectIpv6 picks the last global unicast address", () => {
  const found = detectIpv6({
    lo: [ipv6Interface("::1", true)],
    wlan0: [
      ipv6Interface("fe80::1"),
      ipv6Interface("240e:390:abcd:1234:aaaa:bbbb:cccc:dddd"),
      ipv6Interface("fd12:3456::1"),
    ],
  });
  assert.equal(found, "240e:390:abcd:1234:aaaa:bbbb:cccc:dddd");
  assert.equal(detectIpv6({ lo: [ipv6Interface("::1", true)] }), undefined);
});

test("detectPublicIpv4 asks a plain-text service and validates the answer", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      const body = new Response("203.0.113.9\n", { status: 200 });
      return body;
    }) as typeof fetch;
    assert.equal(await detectPublicIpv4(), "203.0.113.9");

    globalThis.fetch = (async () => {
      return new Response("not-an-ip", { status: 200 });
    }) as typeof fetch;
    assert.equal(await detectPublicIpv4(), undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test("syncDdns with no addresses enabled skips the provider", async () => {
  const original = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("KO", { status: 200 });
    }) as typeof fetch;
    const result = await syncDdns({
      provider: "duckdns",
      host: "mydeck.duckdns.org",
      token: "tok",
      ipv4: "none",
      ipv6: "none",
      intervalMinutes: 10,
    });
    assert.equal(calls, 0);
    assert.equal(result.updated, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("syncDdns duckdns reports OK with the detected addresses", async () => {
  const original = globalThis.fetch;
  try {
    const urls: string[] = [];
    globalThis.fetch = (async (input: any) => {
      urls.push(String(input));
      return new Response("OK\n", { status: 200 });
    }) as typeof fetch;
    const result = await syncDdns({
      provider: "duckdns",
      host: "mydeck.duckdns.org",
      token: "tok",
      ipv4: "203.0.113.9",
      ipv6: "240e:390:abcd:1234::1",
      intervalMinutes: 10,
    });
    assert.equal(result.updated, true);
    assert.match(urls[0], /domains=mydeck/);
    assert.match(urls[0], /ip=203\.0\.113\.9/);
    assert.match(urls[0], /ipv6=240e%3A390/);
  } finally {
    globalThis.fetch = original;
  }
});

test("syncDdns duckdns strips the .duckdns.org suffix for the API", async () => {
  const original = globalThis.fetch;
  try {
    const urls: string[] = [];
    globalThis.fetch = (async (input: any) => {
      urls.push(String(input));
      return new Response("OK", { status: 200 });
    }) as typeof fetch;
    await syncDdns({
      provider: "duckdns",
      host: "mydeck.duckdns.org",
      token: "tok",
      ipv4: "203.0.113.9",
      ipv6: "none",
      intervalMinutes: 10,
    });
    assert.match(urls[0], /domains=mydeck/);
    assert.doesNotMatch(urls[0], /mydeck\.duckdns\.org/);
  } finally {
    globalThis.fetch = original;
  }
});

test("syncDdns cloudflare creates, updates and skips A/AAAA records", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; method: string; body?: string }[] = [];
  const respond = (json: any) =>
    new Response(JSON.stringify({ success: true, ...json }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  try {
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = String(input);
      calls.push({ url, method: init.method || "GET", body: init.body });
      if (url.includes("dns_records?name=") && init.method === "GET") {
        if (url.includes("type=AAAA"))
          return respond({ result: [{ id: "r-aaaa", content: "240e:390:abcd:1234::1" }] });
        return respond({ result: [{ id: "r-a", content: "198.51.100.2" }] });
      }
      return respond({ result: { id: "new" } });
    }) as typeof fetch;

    const result = await syncDdns({
      provider: "cloudflare",
      host: "deck.example.com",
      token: "cf-tok",
      zone: "zone123",
      ipv4: "198.51.100.2",
      ipv6: "240e:390:abcd:1234::1",
      intervalMinutes: 10,
    });

    const patched = calls.filter((call) => call.method === "PATCH");
    assert.equal(patched.length, 0, "unchanged A/AAAA records are not touched");
    assert.equal(result.updated, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("syncDdns cloudflare patches changed records and creates missing ones", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; method: string; body?: string }[] = [];
  const respond = (json: any) =>
    new Response(JSON.stringify({ success: true, ...json }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  try {
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = String(input);
      calls.push({ url, method: init.method || "GET", body: init.body });
      if (url.includes("dns_records?name=") && init.method === "GET") {
        if (url.includes("type=AAAA")) return respond({ result: [] });
        return respond({ result: [{ id: "r-a", content: "198.51.100.2" }] });
      }
      return respond({ result: { id: "new" } });
    }) as typeof fetch;

    const result = await syncDdns({
      provider: "cloudflare",
      host: "deck.example.com",
      token: "cf-tok",
      zone: "zone123",
      ipv4: "203.0.113.9",
      ipv6: "240e:390:abcd:1234::1",
      intervalMinutes: 10,
    });

    const patched = calls.filter((call) => call.method === "PATCH");
    assert.equal(patched.length, 1, "the changed A record is patched");
    assert.equal(JSON.parse(patched[0].body || "").content, "203.0.113.9");
    const creates = calls.filter((call) => call.method === "POST");
    assert.equal(creates.length, 1, "the missing AAAA record is created");
    assert.equal(JSON.parse(creates[0].body || "").type, "AAAA");
    assert.equal(result.updated, true);
  } finally {
    globalThis.fetch = original;
  }
});

test("syncDdns cloudflare surfaces API errors", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ success: false, errors: [{ message: "bad token" }] }),
        { status: 403 },
      )) as typeof fetch;
    await assert.rejects(
      syncDdns({
        provider: "cloudflare",
        host: "deck.example.com",
        token: "cf-tok",
        zone: "zone123",
        ipv4: "203.0.113.9",
        ipv6: "none",
        intervalMinutes: 10,
      }),
      /bad token/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
