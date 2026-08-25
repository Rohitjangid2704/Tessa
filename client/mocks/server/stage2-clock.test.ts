import { describe, expect, it } from "vitest";
import { SimulationClock } from "@/mocks/simulation/clock";

function newClock(speed = 1): SimulationClock {
  const clock = new SimulationClock();
  clock.setSpeed(speed);
  return clock;
}

describe("SimulationClock", () => {
  it("fires sleepers in due order and keeps insertion order for ties", async () => {
    const clock = newClock();
    clock.pause();
    const fired: string[] = [];
    void clock.sleepUntil(300).then(() => fired.push("late"));
    void clock.sleepUntil(100).then(() => fired.push("first"));
    void clock.sleepUntil(100).then(() => fired.push("second"));
    await clock.advance(500);
    expect(fired).toEqual(["first", "second", "late"]);
  });

  it("lets a woken coroutine register an earlier sleeper before later ones fire", async () => {
    const clock = newClock();
    clock.pause();
    const fired: string[] = [];
    void clock.sleepUntil(100).then(async () => {
      fired.push("a1");
      await clock.sleepUntil(150);
      fired.push("a2");
    });
    void clock.sleepUntil(200).then(() => fired.push("b"));
    await clock.advance(1000);
    expect(fired).toEqual(["a1", "a2", "b"]);
  });

  it("does not fire while paused and resumes at the configured speed", async () => {
    const clock = newClock(1000);
    clock.pause();
    let woke = false;
    void clock.sleep(500).then(() => {
      woke = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(woke).toBe(false);
    clock.resume();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(woke).toBe(true);
  });

  it("scales real time by the speed factor", async () => {
    const clock = newClock(50);
    const started = performance.now();
    await clock.sleep(1000);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(15);
    expect(elapsed).toBeLessThan(400);
  });

  it("runs every pending sleeper with runUntilIdle and reports the snapshot", async () => {
    const clock = newClock();
    clock.pause();
    const fired: number[] = [];
    for (const due of [5000, 1000, 3000]) {
      void clock.sleepUntil(due).then(() => fired.push(due));
    }
    expect(clock.snapshot()).toMatchObject({ paused: true, sleepers: 3 });
    await clock.runUntilIdle();
    expect(fired).toEqual([1000, 3000, 5000]);
    expect(clock.snapshot().sleepers).toBe(0);
  });

  it("drops pending sleepers and restores the default speed on reset", () => {
    const clock = newClock(7);
    clock.defaultSpeed = 2;
    void clock.sleep(10_000);
    clock.reset();
    expect(clock.snapshot()).toMatchObject({ speed: 2, paused: false, sleepers: 0 });
  });
});
