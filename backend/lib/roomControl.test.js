const test = require("node:test");
const assert = require("node:assert");
const { RoomControl } = require("./roomControl");

// A socket that answers every rpc, so flush() can be observed end to end.
function fakeSocket({ fail = false, sent = [] } = {}) {
  const socket = {
    readyState: 1,
    send(raw) {
      const msg = JSON.parse(raw);
      sent.push(msg);
      setImmediate(() => {
        socket.onmessage(
          fail
            ? { type: "rpc-err", id: msg.id, error: "denied" }
            : { type: "rpc-ok", id: msg.id, result: { ok: true, op: msg.op } }
        );
      });
    },
  };
  return socket;
}

function attached(control, opts) {
  const socket = fakeSocket(opts);
  socket.onmessage = (msg) => control.handle(msg);
  control.attach(socket);
  return socket;
}

const rel = (file, extra = {}) => ({ workspaceId: "/w", file, agentId: "claude:host:s1", ...extra });

test("only replayable mutations are queued", () => {
  const c = new RoomControl();
  assert.equal(c.enqueue("release", rel("a.ts")), true);
  assert.equal(c.enqueue("release-all", { workspaceId: "/w", agentId: "claude:host:s1" }), true);
  // A claim is a question nobody is still asking by the time we reconnect.
  assert.equal(c.enqueue("claim", rel("a.ts")), false);
  // A heartbeat asserts liveness *now*; replaying it would revive a dead lock.
  assert.equal(c.enqueue("heartbeat", rel("a.ts")), false);
  assert.equal(c.queued, 2);
});

test("repeated releases of one file collapse to a single entry", () => {
  const c = new RoomControl();
  c.enqueue("release", rel("a.ts"));
  c.enqueue("release", rel("a.ts"));
  c.enqueue("release", rel("b.ts"));
  assert.equal(c.queued, 2);
});

test("releases are namespaced by workspace and agent", () => {
  const c = new RoomControl();
  c.enqueue("release", rel("a.ts"));
  c.enqueue("release", { ...rel("a.ts"), workspaceId: "/other" });
  c.enqueue("release", { ...rel("a.ts"), agentId: "cursor:host:s2" });
  assert.equal(c.queued, 3);
});

test("the queue is bounded and drops the oldest first", () => {
  const c = new RoomControl();
  for (let i = 0; i < 250; i++) c.enqueue("release", rel(`f${i}.ts`));
  assert.equal(c.queued, 200);
  const files = c.queue.map((item) => item.body.file);
  assert.ok(!files.includes("f0.ts"), "oldest entry should have been dropped");
  assert.ok(files.includes("f249.ts"), "newest entry should survive");
});

test("flush replays in enqueue order and drains the queue", async () => {
  const c = new RoomControl();
  const sent = [];
  attached(c, { sent });
  c.enqueue("release", rel("a.ts"));
  c.enqueue("release", rel("b.ts"));
  c.enqueue("release", rel("c.ts"));

  const { replayed, rejected } = await c.flush();
  assert.equal(replayed.length, 3);
  assert.equal(rejected.length, 0);
  assert.deepEqual(sent.map((m) => m.body.file), ["a.ts", "b.ts", "c.ts"]);
  assert.equal(c.queued, 0, "queue must be drained so a rejecting host is not retried forever");
});

test("a re-queued release replays after the ones already waiting", async () => {
  const c = new RoomControl();
  const sent = [];
  attached(c, { sent });
  c.enqueue("release", rel("a.ts"));
  c.enqueue("release", rel("b.ts"));
  c.enqueue("release", rel("a.ts")); // supersedes the first entry
  await c.flush();
  assert.deepEqual(sent.map((m) => m.body.file), ["b.ts", "a.ts"]);
});

test("rejected replays are reported and still drain", async () => {
  const c = new RoomControl();
  attached(c, { fail: true });
  let seen = null;
  c.onReplay = (outcome) => {
    seen = outcome;
  };
  c.enqueue("release", rel("a.ts"));

  const { replayed, rejected } = await c.flush();
  assert.equal(replayed.length, 0);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].body.file, "a.ts");
  assert.equal(c.queued, 0);
  assert.equal(seen.rejected.length, 1, "onReplay must fire so the notice can be raised");
});

test("flushing while still offline rejects rather than throwing", async () => {
  const c = new RoomControl();
  c.enqueue("release", rel("a.ts"));
  const { replayed, rejected } = await c.flush();
  assert.equal(replayed.length, 0);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].error, "control_offline");
});

test("flush on an empty queue is a no-op and does not call onReplay", async () => {
  const c = new RoomControl();
  let called = false;
  c.onReplay = () => {
    called = true;
  };
  const { replayed, rejected } = await c.flush();
  assert.equal(replayed.length, 0);
  assert.equal(rejected.length, 0);
  assert.equal(called, false);
});

test("a throwing onReplay does not break reconnection", async () => {
  const c = new RoomControl();
  attached(c);
  c.onReplay = () => {
    throw new Error("notice subsystem down");
  };
  c.enqueue("release", rel("a.ts"));
  await assert.doesNotReject(() => c.flush());
});
