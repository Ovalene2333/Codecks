import assert from "node:assert/strict";
import test from "node:test";
import {
  formatElapsed,
  startPhase,
  writeLine,
  type Clock,
} from "./startup-progress.js";

function mockStream(isTTY = false) {
  const chunks: string[] = [];
  return {
    chunks,
    isTTY,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    text() {
      return chunks.join("");
    },
  };
}

function fakeClock(): Clock & { advance: (ms: number) => void } {
  let now = 0;
  const timers = new Map<
    number,
    { cb: () => void; every: number; next: number }
  >();
  let nextId = 1;
  return {
    now: () => now,
    setInterval(cb: () => void, every: number) {
      const id = nextId++;
      timers.set(id, { cb, every, next: now + every });
      return id as unknown as NodeJS.Timeout;
    },
    clearInterval(handle: NodeJS.Timeout) {
      timers.delete(Number(handle));
    },
    advance(ms: number) {
      now += ms;
      for (const timer of timers.values()) {
        while (timer.next <= now) {
          timer.cb();
          timer.next += timer.every;
        }
      }
    },
  };
}

test("formatElapsed uses ms under one second and seconds after", () => {
  assert.equal(formatElapsed(240), "240ms");
  assert.equal(formatElapsed(1200), "1.2s");
  assert.equal(formatElapsed(10_400), "10s");
});

test("writeLine appends a newline", () => {
  const stream = mockStream();
  writeLine(stream, "Codex Deck 启动中（WSL）");
  assert.equal(stream.text(), "Codex Deck 启动中（WSL）\n");
});

test("non-TTY phase prints immediately and heartbeats until done", () => {
  const stream = mockStream();
  const clock = fakeClock();
  const phase = startPhase("正在唤醒 WSL，读取用户目录…", {
    stream,
    waitingLabel: "仍在等待 WSL",
    clock,
  });
  assert.equal(stream.text(), "正在唤醒 WSL，读取用户目录…\n");

  clock.advance(3_000);
  clock.advance(3_000);
  assert.match(stream.text(), /仍在等待 WSL… 3s/);
  assert.match(stream.text(), /仍在等待 WSL… 6s/);

  phase.done("WSL Codex 主目录 /home/tester/.codex");
  assert.match(stream.text(), /WSL Codex 主目录 \/home\/tester\/\.codex（6\.0s）\n$/);

  const before = stream.chunks.length;
  clock.advance(3_000);
  assert.equal(stream.chunks.length, before);
});

test("TTY phase updates the waiting line in place", () => {
  const stream = mockStream(true);
  const clock = fakeClock();
  const phase = startPhase("正在启动 WSL 中的 Codex app-server…", {
    stream,
    waitingLabel: "仍在等待 app-server",
    clock,
  });
  clock.advance(400);
  assert.ok(stream.chunks.some((chunk) => chunk.startsWith("\r仍在等待 app-server… 400ms")));

  phase.done("Codex runtime 已就绪");
  assert.equal(stream.chunks.at(-2), "\r\x1b[K");
  assert.equal(stream.chunks.at(-1), "Codex runtime 已就绪（400ms）\n");
});
