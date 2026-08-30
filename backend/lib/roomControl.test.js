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

test("a transport failure puts the entry back rather than losing it", async () => {
  const c = new RoomControl();
  const socket = attached(c);
  c.enqueue("release", rel("a.ts"));
  c.enqueue("release", rel("b.ts"));
  // The tunnel dies again after the first replay goes out.
  const realSend = socket.send.bind(socket);
  let sends = 0;
  socket.send = (raw) => {
    if (++sends > 1) {
      socket.readyState = 3;
      throw new Error("socket closed");
    }
    realSend(raw);
  };

  const { replayed, rejected, requeued } = await c.flush();
  assert.equal(replayed.length, 1);
  assert.equal(rejected.length, 0, "a dead tunnel is not a host verdict");
  assert.equal(requeued.length, 1);
  assert.equal(c.queued, 1, "the unsent release must survive for the next reconnect");
  assert.equal(c.queue[0].body.file, "b.ts");
});

test("a re-queued entry keeps its place ahead of newer mutations", async () => {
  const c = new RoomControl();
  const socket = attached(c);
  c.enqueue("release", rel("old.ts"));
  socket.readyState = 3; // offline before the replay starts
  await c.flush();
  assert.equal(c.queued, 1);

  socket.readyState = 1;
  const sent = [];
  const fresh = fakeSocket({ sent });
  fresh.onmessage = (msg) => c.handle(msg);
  c.attach(fresh);
  c.enqueue("release", rel("new.ts"));
  await c.flush();
  assert.deepEqual(sent.map((m) => m.body.file), ["old.ts", "new.ts"]);
});

test("a release arriving mid-flush does not overtake the entry being re-queued", async () => {
  // The queue is drained up front, so a release that comes in over HTTP while a
  // replay is in flight lands in an empty queue and gets a fresh seq. If the
  // re-queued entry were re-stamped too it would sort *after* that newer
  // release, and the two would replay out of order.
  const c = new RoomControl();
  const socket = attached(c);
  c.enqueue("release", rel("first.ts"));
  socket.send = () => {
    c.enqueue("release", rel("concurrent.ts")); // arrives during the replay
    socket.readyState = 3;
    throw new Error("socket closed");
  };
  await c.flush();
  assert.equal(c.queued, 2);

  const sent = [];
  const fresh = fakeSocket({ sent });
  fresh.onmessage = (msg) => c.handle(msg);
  c.attach(fresh);
  await c.flush();
  assert.deepEqual(sent.map((m) => m.body.file), ["first.ts", "concurrent.ts"]);
});

test("a host verdict is final and is not re-queued", async () => {
  const c = new RoomControl();
  attached(c, { fail: true });
  c.enqueue("release", rel("a.ts"));
  const { rejected, requeued } = await c.flush();
  assert.equal(rejected.length, 1);
  assert.equal(requeued.length, 0);
  assert.equal(c.queued, 0, "a release the host keeps refusing must not retry forever");
});

test("concurrent flushes share one pass and settled() waits for it", async () => {
  const c = new RoomControl();
  const sent = [];
  attached(c, { sent });
  c.enqueue("release", rel("a.ts"));
  c.enqueue("release", rel("b.ts"));

  const first = c.flush();
  const second = c.flush();
  assert.equal(first, second, "a second flush must not race the first for the same entries");

  let done = false;
  const waiter = c.settled().then(() => {
    done = true;
  });
  assert.equal(done, false, "settled() must not resolve before the replay finishes");
  await Promise.all([first, waiter]);
  assert.equal(done, true);
  // Each entry went out exactly once despite two flush() calls.
  assert.deepEqual(sent.map((m) => m.body.file), ["a.ts", "b.ts"]);
});

test("settled() resolves immediately when nothing is in flight", async () => {
  const c = new RoomControl();
  assert.equal(await c.settled(), null);
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
  const { replayed, rejected, requeued } = await c.flush();
  assert.equal(replayed.length, 0);
  assert.equal(rejected.length, 0);
  assert.equal(requeued.length, 1);
  assert.equal(requeued[0].error, "control_offline");
  assert.equal(c.queued, 1, "still offline is not a reason to throw the release away");
});

test("flush on an empty queue is a no-op and does not call onReplay", async () => {
  const c = new RoomControl();
  let called = false;
  c.onReplay = () => {
    called = true;
  };
  const { replayed, rejected, requeued } = await c.flush();
  assert.equal(replayed.length, 0);
  assert.equal(rejected.length, 0);
  assert.equal(requeued.length, 0);
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
