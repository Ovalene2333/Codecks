import test from "node:test";
import assert from "node:assert/strict";
import { parseCli } from "./cli.js";
import {
  accessUrl,
  cloudflaredArgs,
  normalizePublicOrigin,
} from "./tunnel.js";
import { lanAddresses } from "./network.js";

test("LAN and tunnel flags imply a LAN listener", () => {
  assert.deepEqual(parseCli(["--lan"], {} as any), {
    host: "0.0.0.0",
    port: 4174,
    lan: true,
    lan6: false,
    tunnel: undefined,
    cloudflaredBin: undefined,
    token: undefined,
    noToken: false,
    wsl: false,
    help: false,
  });
  assert.deepEqual(parseCli(["--lan6"], {} as any), {
    host: "::",
    port: 4174,
    lan: true,
    lan6: true,
    tunnel: undefined,
    cloudflaredBin: undefined,
    token: undefined,
    noToken: false,
    wsl: false,
    help: false,
  });
  assert.throws(() => parseCli(["--lan", "--lan6"], {} as any), /不能同时/);
  assert.throws(
    () => parseCli(["--lan6", "--lan"], {} as any),
    /不能同时/,
  );
  assert.deepEqual(parseCli(["--cf-tunnel"], {} as any).tunnel, {
    provider: "cloudflare",
    mode: "quick",
  });
  assert.deepEqual(
    parseCli(["--named-tunnel", "deck-home"], {} as any).tunnel,
    { provider: "cloudflare", mode: "named", name: "deck-home" },
  );
  assert.throws(() => parseCli(["--named-tunnel"], {} as any), /需要指定/);
  assert.deepEqual(
    parseCli(["--share"], {
      CF_TUNNEL_TOKEN: "tok",
      CF_TUNNEL_HOSTNAME: "deck.example.com",
    } as any).tunnel,
    {
      provider: "cloudflare",
      mode: "share",
      hostname: "deck.example.com",
      tunnelToken: "tok",
    },
  );
  assert.deepEqual(
    parseCli(
      ["--share", "--share-host", "deck.example.com", "--tunnel-token", "cli-tok"],
      {} as any,
    ).tunnel,
    {
      provider: "cloudflare",
      mode: "share",
      hostname: "deck.example.com",
      tunnelToken: "cli-tok",
    },
  );
  assert.throws(() => parseCli(["--share"], {} as any), /必须同时设置/);
  assert.throws(
    () => parseCli(["--share", "--cf-tunnel"], {} as any),
    /请只选/,
  );
  assert.equal(parseCli(["--lan", "--no-token"], {} as any).noToken, true);
  assert.equal(parseCli(["--wsl"], {} as any).wsl, true);
  assert.throws(
    () => parseCli(["--no-token", "--token", "secret"], {} as any),
    /不能与/,
  );
});

test("expose and public-origin select modular providers", () => {
  const announced = parseCli(
    ["--public-origin", "https://deck.example.com"],
    {} as any,
  );
  assert.equal(announced.lan, false);
  assert.equal(announced.host, "127.0.0.1");
  assert.deepEqual(announced.tunnel, {
    provider: "announce",
    origin: "https://deck.example.com",
  });

  const cf = parseCli(["--expose", "cloudflare:quick"], {} as any);
  assert.equal(cf.lan, true);
  assert.equal(cf.host, "0.0.0.0");
  assert.deepEqual(cf.tunnel, { provider: "cloudflare", mode: "quick" });

  assert.deepEqual(
    parseCli(["--expose", "cf:named=Deck-Home"], {} as any).tunnel,
    { provider: "cloudflare", mode: "named", name: "Deck-Home" },
  );
  assert.deepEqual(
    parseCli(
      ["--named-tunnel", "deck-home", "--public-origin", "deck.example.com"],
      {} as any,
    ).tunnel,
    {
      provider: "cloudflare",
      mode: "named",
      name: "deck-home",
      origin: "deck.example.com",
    },
  );
  assert.deepEqual(
    parseCli(["--expose", "cloudflare:share"], {
      CF_TUNNEL_TOKEN: "tok",
      CF_TUNNEL_HOSTNAME: "deck.example.com",
    } as any).tunnel,
    {
      provider: "cloudflare",
      mode: "share",
      hostname: "deck.example.com",
      tunnelToken: "tok",
    },
  );

  const command = parseCli(
    [
      "--expose",
      "command",
      "--tunnel-bin",
      "ngrok",
      "--tunnel-args",
      "http {port}",
      "--tunnel-url-pattern",
      "https://[a-z0-9-]+\\.ngrok-free\\.app",
    ],
    {} as any,
  );
  assert.equal(command.lan, true);
  assert.deepEqual(command.tunnel, {
    provider: "command",
    bin: "ngrok",
    argsTemplate: "http {port}",
    urlPattern: "https://[a-z0-9-]+\\.ngrok-free\\.app",
    origin: undefined,
  });

  assert.deepEqual(
    parseCli([], {
      CODEX_DECK_EXPOSE: "command",
      CODEX_DECK_TUNNEL_BIN: "bore",
      CODEX_DECK_TUNNEL_ARGS: "local {port} --to bore.pub",
      CODEX_DECK_PUBLIC_ORIGIN: "https://abc.bore.pub",
    } as any).tunnel,
    {
      provider: "command",
      bin: "bore",
      argsTemplate: "local {port} --to bore.pub",
      urlPattern: undefined,
      origin: "https://abc.bore.pub",
    },
  );

  assert.throws(
    () => parseCli(["--expose", "command"], {} as any),
    /TUNNEL_BIN/,
  );
  assert.throws(
    () => parseCli(["--expose", "announce"], {} as any),
    /public-origin/,
  );
  assert.throws(
    () => parseCli(["--expose", "command", "--cf-tunnel"], {} as any),
    /冲突/,
  );
  assert.throws(
    () => parseCli(["--expose", "wireguard"], {} as any),
    /未知的 --expose 供应商/,
  );
});

test("compatible expose flags can be combined with the same provider", () => {
  assert.deepEqual(
    parseCli(["--expose", "cloudflare:quick", "--cf-tunnel"], {} as any)
      .tunnel,
    { provider: "cloudflare", mode: "quick" },
  );
});

test("cloudflared args distinguish quick and named tunnels", () => {
  assert.deepEqual(
    cloudflaredArgs({ provider: "cloudflare", mode: "quick" }, 4174).slice(
      0,
      3,
    ),
    ["tunnel", "--url", "http://127.0.0.1:4174"],
  );
  assert.deepEqual(
    cloudflaredArgs(
      { provider: "cloudflare", mode: "named", name: "deck-home" },
      4174,
    ),
    ["tunnel", "--url", "http://127.0.0.1:4174", "run", "deck-home"],
  );
  assert.deepEqual(
    cloudflaredArgs(
      {
        provider: "cloudflare",
        mode: "share",
        hostname: "deck.example.com",
        tunnelToken: "tok",
      },
      4174,
    ),
    ["tunnel", "run", "--token", "tok"],
  );
  assert.equal(
    normalizePublicOrigin("deck.example.com"),
    "https://deck.example.com",
  );
  assert.equal(
    accessUrl("https://demo.trycloudflare.com/", "a b"),
    "https://demo.trycloudflare.com/#token=a%20b",
  );
  assert.equal(
    accessUrl("https://demo.trycloudflare.com/", ""),
    "https://demo.trycloudflare.com/",
  );
});

test("LAN URLs include token in a fragment and omit loopback", () => {
  const urls = lanAddresses(4174, "secret", {
    lo: [
      {
        address: "127.0.0.1",
        netmask: "255.0.0.0",
        family: "IPv4",
        mac: "",
        internal: true,
        cidr: "127.0.0.1/8",
      },
    ],
    eth0: [
      {
        address: "192.168.1.9",
        netmask: "255.255.255.0",
        family: "IPv4",
        mac: "",
        internal: false,
        cidr: "192.168.1.9/24",
      },
    ],
  });
  assert.deepEqual(urls, ["http://192.168.1.9:4174/#token=secret"]);
});

test("IPv6 LAN URLs are bracketed and skip link-local and loopback", () => {
  const base = {
    lo: [
      {
        address: "::1",
        netmask: "ffff:ffff:ffff:ffff::",
        family: "IPv6",
        mac: "",
        internal: true,
        scopeid: 0,
        cidr: "::1/128",
      },
    ],
    wlan0: [
      {
        address: "fe80::1%wlan0",
        netmask: "ffff:ffff:ffff:ffff::",
        family: "IPv6",
        mac: "",
        internal: false,
        scopeid: 5,
        cidr: "fe80::1/64",
      },
      {
        address: "240e:390:abcd:1234:aaaa:bbbb:cccc:dddd",
        netmask: "ffff:ffff:ffff:ffff::",
        family: "IPv6",
        mac: "",
        internal: false,
        scopeid: 0,
        cidr: "240e:390:abcd:1234::/64",
      },
    ],
  } as any;
  assert.deepEqual(lanAddresses(4174, "secret", base, "ipv6"), [
    "http://[240e:390:abcd:1234:aaaa:bbbb:cccc:dddd]:4174/#token=secret",
  ]);
  assert.deepEqual(lanAddresses(4174, "secret", base, "ipv4"), []);
});

test("ddns expose resolves from env and selects the listener family", () => {
  const duckdns = parseCli(["--expose", "ddns:duckdns"], {
    DDNS_HOST: "mydeck.duckdns.org",
    DDNS_TOKEN: "tok",
  } as any);
  assert.equal(duckdns.lan, true);
  assert.equal(duckdns.host, "::");
  assert.deepEqual(duckdns.tunnel, {
    provider: "ddns",
    ddns: {
      provider: "duckdns",
      host: "mydeck.duckdns.org",
      token: "tok",
      zone: undefined,
      ipv4: "none",
      ipv6: "auto",
      intervalMinutes: 10,
    },
  });

  const v4Only = parseCli(
    ["--expose", "ddns:cloudflare"],
    {
      DDNS_HOST: "deck.example.com",
      DDNS_TOKEN: "cf-tok",
      DDNS_ZONE: "zone123",
      DDNS_IPV6: "none",
      DDNS_INTERVAL: "5",
    } as any,
  );
  assert.equal(v4Only.host, "0.0.0.0");
  assert.deepEqual(v4Only.tunnel, {
    provider: "ddns",
    ddns: {
      provider: "cloudflare",
      host: "deck.example.com",
      token: "cf-tok",
      zone: "zone123",
      ipv4: "none",
      ipv6: "none",
      intervalMinutes: 5,
    },
  });

  const pinned = parseCli(
    ["--expose", "ddns:duckdns"],
    {
      DDNS_HOST: "mydeck.duckdns.org",
      DDNS_TOKEN: "tok",
      DDNS_IPV6: "240e:390:abcd:1234::1",
      DDNS_IPV4: "auto",
    } as any,
  );
  assert.equal(
    (pinned.tunnel as any).ddns.ipv6,
    "240e:390:abcd:1234::1",
  );
  assert.equal((pinned.tunnel as any).ddns.ipv4, "auto");

  assert.throws(
    () => parseCli(["--expose", "ddns"], {} as any),
    /需要指定供应商/,
  );
  assert.throws(
    () =>
      parseCli(["--expose", "ddns:duckdns"], {
        DDNS_HOST: "mydeck.duckdns.org",
      } as any),
    /DDNS_TOKEN/,
  );
  assert.throws(
    () =>
      parseCli(["--expose", "ddns:cloudflare"], {
        DDNS_HOST: "deck.example.com",
        DDNS_TOKEN: "tok",
      } as any),
    /DDNS_ZONE/,
  );
  assert.throws(
    () =>
      parseCli(["--expose", "ddns:duckdns"], {
        DDNS_HOST: "mydeck.duckdns.org",
        DDNS_TOKEN: "tok",
        DDNS_IPV6: "127.0.0.1",
      } as any),
    /IPv6/,
  );
  assert.throws(
    () =>
      parseCli(["--expose", "ddns:duckdns"], {
        DDNS_HOST: "mydeck.duckdns.org",
        DDNS_TOKEN: "tok",
        DDNS_INTERVAL: "0",
      } as any),
    /DDNS_INTERVAL/,
  );
});
