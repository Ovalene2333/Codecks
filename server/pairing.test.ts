import test from "node:test";
import assert from "node:assert/strict";
import { codeFor, Pairing, PairRateLimiter } from "./pairing.js";

test("codeFor derives a deterministic 6-digit code per window", () => {
  const a = codeFor(123456, "secret");
  assert.match(a, /^\d{6}$/);
  assert.equal(codeFor(123456, "secret"), a);
  assert.notEqual(codeFor(123457, "secret"), a);
  assert.notEqual(codeFor(123456, "other"), a);
});

test("Pairing verifies the current and previous windows", () => {
  const pairing = new Pairing("secret", 1000);
  const current = codeFor(Math.floor(Date.now() / 1000), "secret");
  const previous = codeFor(Math.floor(Date.now() / 1000) - 1, "secret");
  assert.equal(pairing.verify(current), true);
  assert.equal(pairing.verify(previous), true);
  assert.equal(pairing.verify("000000"), false);
  assert.equal(pairing.verify("abc123"), false);
  assert.equal(pairing.verify("12345"), false);
});

test("Pairing only accepts codes from the current or previous window", () => {
  const windowMs = 60_000;
  const pairing = new Pairing("secret", windowMs);
  const epoch = Math.floor(Date.now() / windowMs);
  assert.equal(pairing.verify(codeFor(epoch, "secret")), true);
  assert.equal(pairing.verify(codeFor(epoch - 1, "secret")), true);
  assert.equal(pairing.verify(codeFor(epoch - 2, "secret")), false);
  assert.equal(pairing.verify(codeFor(epoch + 1, "secret")), false);
});

test("PairRateLimiter locks an IP after five failures", () => {
  const limiter = new PairRateLimiter();
  const ip = "10.0.0.1";
  for (let index = 0; index < 5; index += 1) {
    assert.equal(limiter.allowed(ip), true);
    limiter.failed(ip);
  }
  assert.equal(limiter.allowed(ip), false, "locked after 5 failures");
  limiter.ok(ip);
  assert.equal(limiter.allowed(ip), true, "a successful pair resets the IP");
});
