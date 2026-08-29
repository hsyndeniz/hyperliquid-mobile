import { Generation, LatestWinsQueue, PerKeyMutationQueue } from "@/hyperliquid/core/queues";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("PerKeyMutationQueue", () => {
  it("serialises operations on the same key", async () => {
    const queue = new PerKeyMutationQueue();
    const order: string[] = [];

    const slow = queue.run("BTC", async () => {
      order.push("start-1");
      await tick();
      order.push("end-1");
    });
    const fast = queue.run("BTC", async () => {
      order.push("start-2");
      order.push("end-2");
    });

    await Promise.all([slow, fast]);
    // The second must not begin until the first has finished.
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });

  it("keeps different keys fully parallel", async () => {
    const queue = new PerKeyMutationQueue();
    const order: string[] = [];

    const btc = queue.run("BTC", async () => {
      order.push("btc-start");
      await tick();
      order.push("btc-end");
    });
    const eth = queue.run("ETH", async () => {
      order.push("eth-start");
      order.push("eth-end");
    });

    await Promise.all([btc, eth]);
    // ETH finishes while BTC is still awaiting — subscribing to one market must
    // never wait behind another.
    expect(order).toEqual(["btc-start", "eth-start", "eth-end", "btc-end"]);
  });

  it("closes the stale-create race: a later destroy always runs after an earlier create", async () => {
    // The exact bug this exists to prevent — BTC -> ETH -> BTC in quick
    // succession leaving a subscription the app believes is gone.
    const queue = new PerKeyMutationQueue();
    const log: string[] = [];

    const create = queue.run("key", async () => {
      await tick();
      log.push("create");
    });
    const destroy = queue.run("key", async () => {
      log.push("destroy");
    });

    await Promise.all([create, destroy]);
    expect(log).toEqual(["create", "destroy"]);
  });

  it("returns each operation's own result", async () => {
    const queue = new PerKeyMutationQueue();
    await expect(queue.run("k", async () => 42)).resolves.toBe(42);
  });

  it("propagates a failure to its own caller only", async () => {
    const queue = new PerKeyMutationQueue();
    const failing = queue.run("k", async () => {
      throw new Error("boom");
    });
    const following = queue.run("k", async () => "ok");

    await expect(failing).rejects.toThrow("boom");
    // A subscription failing to open must not wedge that market forever.
    await expect(following).resolves.toBe("ok");
  });

  it("still serialises after a failure", async () => {
    const queue = new PerKeyMutationQueue();
    const order: string[] = [];
    const a = queue.run("k", async () => {
      await tick();
      order.push("a");
      throw new Error("x");
    });
    const b = queue.run("k", async () => {
      order.push("b");
    });
    await Promise.allSettled([a, b]);
    expect(order).toEqual(["a", "b"]);
  });

  it("reports busy while work is outstanding and releases afterwards", async () => {
    const queue = new PerKeyMutationQueue();
    const running = queue.run("k", tick);
    expect(queue.isBusy("k")).toBe(true);
    await running;
    await tick();
    expect(queue.isBusy("k")).toBe(false);
  });

  it("does not leak keys across a long run of switches", async () => {
    const queue = new PerKeyMutationQueue();
    for (let i = 0; i < 50; i += 1) {
      await queue.run(`coin-${i}`, async () => undefined);
    }
    await tick();
    expect(queue.activeKeyCount).toBe(0);
  });
});

describe("LatestWinsQueue", () => {
  it("runs a single request", async () => {
    const queue = new LatestWinsQueue();
    const ran: number[] = [];
    await queue.request(async () => {
      ran.push(1);
    });
    expect(ran).toEqual([1]);
  });

  it("discards superseded requests and runs only the newest", async () => {
    const queue = new LatestWinsQueue();
    const ran: number[] = [];

    const first = queue.request(async () => {
      ran.push(1);
      await tick();
    });
    const second = queue.request(async () => {
      ran.push(2);
    });
    const third = queue.request(async () => {
      ran.push(3);
    });

    await Promise.all([first, second, third]);
    // 2 is superseded by 3 before it ever starts — computing it would produce
    // an already-stale state.
    expect(ran).toEqual([1, 3]);
  });

  it("resolves waiters even when their own operation was superseded", async () => {
    const queue = new LatestWinsQueue();
    const first = queue.request(async () => {
      await tick();
    });
    const superseded = queue.request(async () => undefined);
    const newest = queue.request(async () => undefined);
    await expect(Promise.all([first, superseded, newest])).resolves.toBeDefined();
  });

  it("keeps running after a failure", async () => {
    const queue = new LatestWinsQueue();
    const ran: string[] = [];
    await queue.request(async () => {
      throw new Error("boom");
    });
    await queue.request(async () => {
      ran.push("after");
    });
    expect(ran).toEqual(["after"]);
  });

  it("reports its state", async () => {
    const queue = new LatestWinsQueue();
    expect(queue.isRunning).toBe(false);
    const running = queue.request(async () => {
      await tick();
    });
    expect(queue.isRunning).toBe(true);
    await running;
    expect(queue.isRunning).toBe(false);
    expect(queue.hasPending).toBe(false);
  });
});

describe("Generation", () => {
  it("starts current and invalidates on bump", () => {
    const generation = new Generation();
    const token = generation.current();
    expect(generation.isCurrent(token)).toBe(true);
    generation.bump();
    // Work started before the bump must not write its result.
    expect(generation.isCurrent(token)).toBe(false);
  });

  it("makes the new token current", () => {
    const generation = new Generation();
    generation.bump();
    expect(generation.isCurrent(generation.current())).toBe(true);
  });

  it("increases monotonically", () => {
    const generation = new Generation();
    expect(generation.bump()).toBe(1);
    expect(generation.bump()).toBe(2);
  });
});
