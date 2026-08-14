import test from "node:test";
import assert from "node:assert/strict";
import {
  detectPublicOrigin,
  expandTunnelArgs,
  parseExposeSpec,
  startTunnel,
} from "./tunnel.js";

test("parseExposeSpec accepts provider aliases and named profiles", () => {
  assert.deepEqual(parseExposeSpec("cf"), {
    provider: "cloudflare",
    mode: "quick",
  });
  assert.deepEqual(parseExposeSpec("cloudflare"), {
    provider: "cloudflare",
    mode: "quick",
  });
  assert.deepEqual(parseExposeSpec("cloudflare:share"), {
    provider: "cloudflare",
    mode: "share",
  });
  assert.deepEqual(parseExposeSpec("cloudflare:named=Deck"), {
    provider: "cloudflare",
    mode: "named",
    name: "Deck",
  });
  assert.deepEqual(parseExposeSpec("announce"), { provider: "announce" });
  assert.deepEqual(parseExposeSpec("command"), { provider: "command" });
  assert.throws(() => parseExposeSpec("cloudflare:foo"), /未知的 Cloudflare/);
  assert.throws(() => parseExposeSpec("announce:extra"), /不接受额外参数/);
});

test("expandTunnelArgs substitutes port placeholders and keeps quotes", () => {
  assert.deepEqual(expandTunnelArgs("http {port}", 4174), ["http", "4174"]);
  assert.deepEqual(expandTunnelArgs("tunnel --url {url}", 4174), [
    "tunnel",
    "--url",
    "http://127.0.0.1:4174",
  ]);
  assert.deepEqual(expandTunnelArgs('--header "x: {port}"', 80), [
    "--header",
    "x: 80",
  ]);
});

test("detectPublicOrigin prefers a non-loopback https URL", () => {
  assert.equal(
    detectPublicOrigin(
      "Forwarding http://localhost:4174 -> https://abc.ngrok-free.app",
    ),
    "https://abc.ngrok-free.app",
  );
  assert.equal(
    detectPublicOrigin("https://127.0.0.1 https://deck.example.com/path"),
    "https://deck.example.com",
  );
  assert.equal(
    detectPublicOrigin(
      "see localhost then https://keep.example.com",
      "(localhost)",
    ),
    undefined,
  );
  assert.equal(
    detectPublicOrigin(
      "opened https://keep.example.com",
      "(https://keep\\.example\\.com)",
    ),
    "https://keep.example.com",
  );
  assert.equal(detectPublicOrigin("no urls here"), undefined);
});

test("announce provider prints a tokenized public origin", () => {
  const writes: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    writes.push(String(chunk));
    return write(chunk, ...args);
  }) as typeof process.stdout.write;
  try {
    const tunnel = startTunnel(
      { provider: "announce", origin: "deck.example.com" },
      4174,
      "tok",
    );
    tunnel.kill();
  } finally {
    process.stdout.write = write;
  }
  assert.match(writes.join(""), /https:\/\/deck\.example\.com\/#token=tok/);
});

test("command provider detects a public https origin from stdout", async () => {
  const writes: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    writes.push(String(chunk));
    return write(chunk, ...args);
  }) as typeof process.stdout.write;

  const tunnel = startTunnel(
    {
      provider: "command",
      bin: process.execPath,
      argsTemplate: `-e "console.log('ready https://abc.example.com'); setInterval(() => {}, 1000)"`,
    },
    4174,
    "tok",
  );
  try {
    await waitFor(
      () => writes.join("").includes("https://abc.example.com/#token=tok"),
      5_000,
    );
  } finally {
    tunnel.kill();
    process.stdout.write = write;
  }
});

function waitFor(predicate: () => boolean, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`timed out: ${predicate.toString()}`));
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}
