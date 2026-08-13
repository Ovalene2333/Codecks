import test from "node:test";
import assert from "node:assert/strict";
import { parseCli } from "./cli.js";
import { accessUrl, cloudflaredArgs } from "./tunnel.js";
import { lanAddresses } from "./network.js";

test("LAN and tunnel flags imply a LAN listener", () => {
  assert.deepEqual(parseCli(["--lan"], {} as any), {
    host: "0.0.0.0",
    port: 4174,
    lan: true,
    tunnel: undefined,
    cloudflaredBin: undefined,
    token: undefined,
    noToken: false,
    help: false,
  });
  assert.deepEqual(parseCli(["--cf-tunnel"], {} as any).tunnel, {
    mode: "quick",
  });
  assert.deepEqual(
    parseCli(["--named-tunnel", "deck-home"], {} as any).tunnel,
    { mode: "named", name: "deck-home" },
  );
  assert.throws(() => parseCli(["--named-tunnel"], {} as any), /需要指定/);
  assert.equal(parseCli(["--lan", "--no-token"], {} as any).noToken, true);
  assert.throws(
    () => parseCli(["--no-token", "--token", "secret"], {} as any),
    /不能与/,
  );
});

test("cloudflared args distinguish quick and named tunnels", () => {
  assert.deepEqual(cloudflaredArgs({ mode: "quick" }, 4174).slice(0, 3), [
    "tunnel",
    "--url",
    "http://127.0.0.1:4174",
  ]);
  assert.deepEqual(
    cloudflaredArgs({ mode: "named", name: "deck-home" }, 4174),
    ["tunnel", "--url", "http://127.0.0.1:4174", "run", "deck-home"],
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
