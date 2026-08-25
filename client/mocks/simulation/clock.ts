interface Sleeper {
  due: number;
  resolve: () => void;
}

export const DEFAULT_SIMULATION_SPEED = 1;
export const MAX_SIMULATION_SPEED = 100_000;
const MIN_TIMER_DELAY_MS = 1;
const MAX_IDLE_ITERATIONS = 1_000_000;

function flushContinuations(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface ClockSnapshot {
  speed: number;
  paused: boolean;
  now_ms: number;
  sleepers: number;
  next_due_in_ms: number | null;
}

export class SimulationClock {
  defaultSpeed = DEFAULT_SIMULATION_SPEED;
  private speedFactor = DEFAULT_SIMULATION_SPEED;
  private isPaused = false;
  private base = 0;
  private syncedAt = performance.now();
  private sleepers: Sleeper[] = [];
  private timer: ReturnType<typeof setTimeout> | ReturnType<typeof setImmediate> | null = null;
  private timerIsImmediate = false;
  private running: Promise<void> | null = null;
  private generation = 0;

  get speed(): number {
    return this.speedFactor;
  }

  get paused(): boolean {
    return this.isPaused;
  }

  now(): number {
    if (this.isPaused) {
      return this.base;
    }
    return this.base + (performance.now() - this.syncedAt) * this.speedFactor;
  }

  snapshot(): ClockSnapshot {
    const next = this.sleepers[0];
    return {
      speed: this.speedFactor,
      paused: this.isPaused,
      now_ms: Math.round(this.now()),
      sleepers: this.sleepers.length,
      next_due_in_ms: next === undefined ? null : Math.max(0, Math.round(next.due - this.now())),
    };
  }

  setSpeed(speed: number): void {
    this.sync();
    this.speedFactor = Math.min(MAX_SIMULATION_SPEED, Math.max(0.001, speed));
    this.arm();
  }

  pause(): void {
    this.sync();
    this.isPaused = true;
    this.disarm();
  }

  resume(): void {
    if (!this.isPaused) {
      return;
    }
    this.syncedAt = performance.now();
    this.isPaused = false;
    this.arm();
  }

  sleepUntil(due: number): Promise<void> {
    return new Promise((resolve) => {
      this.insert({ due, resolve });
      if (this.running === null) {
        this.arm();
      }
    });
  }

  sleep(milliseconds: number): Promise<void> {
    return this.sleepUntil(this.now() + milliseconds);
  }

  async advance(milliseconds: number): Promise<void> {
    this.sync();
    this.base += Math.max(0, milliseconds);
    do {
      await this.process();
    } while (this.hasDueSleeper());
  }

  async runUntilIdle(): Promise<number> {
    const generation = this.generation;
    let fired = 0;
    while (this.sleepers.length > 0 && fired < MAX_IDLE_ITERATIONS) {
      if (generation !== this.generation) {
        break;
      }
      const next = this.sleepers[0];
      if (next === undefined) {
        break;
      }
      this.sync();
      this.base = Math.max(this.base, next.due);
      do {
        await this.process();
      } while (this.hasDueSleeper());
      fired += 1;
    }
    return fired;
  }

  reset(): void {
    this.generation += 1;
    this.disarm();
    this.sleepers = [];
    this.speedFactor = this.defaultSpeed;
    this.isPaused = false;
    this.base = 0;
    this.syncedAt = performance.now();
  }

  private hasDueSleeper(): boolean {
    const next = this.sleepers[0];
    return next !== undefined && next.due <= this.now();
  }

  private insert(sleeper: Sleeper): void {
    let index = this.sleepers.length;
    while (index > 0) {
      const previous = this.sleepers[index - 1];
      if (previous === undefined || previous.due <= sleeper.due) {
        break;
      }
      index -= 1;
    }
    this.sleepers.splice(index, 0, sleeper);
  }

  private sync(): void {
    this.base = this.now();
    this.syncedAt = performance.now();
  }

  private disarm(): void {
    if (this.timer === null) {
      return;
    }
    if (this.timerIsImmediate) {
      clearImmediate(this.timer as ReturnType<typeof setImmediate>);
    } else {
      clearTimeout(this.timer as ReturnType<typeof setTimeout>);
    }
    this.timer = null;
  }

  private arm(): void {
    this.disarm();
    if (this.isPaused) {
      return;
    }
    const next = this.sleepers[0];
    if (next === undefined) {
      return;
    }
    const delay = (next.due - this.now()) / this.speedFactor;
    if (delay < MIN_TIMER_DELAY_MS) {
      this.timerIsImmediate = true;
      this.timer = setImmediate(() => void this.process());
      return;
    }
    this.timerIsImmediate = false;
    this.timer = setTimeout(() => void this.process(), delay);
  }

  private process(): Promise<void> {
    if (this.running !== null) {
      return this.running;
    }
    this.timer = null;
    const generation = this.generation;
    const drained = this.drain(generation).finally(() => {
      this.running = null;
      if (generation === this.generation) {
        this.arm();
      }
    });
    this.running = drained;
    return drained;
  }

  private async drain(generation: number): Promise<void> {
    for (;;) {
      if (generation !== this.generation) {
        return;
      }
      const next = this.sleepers[0];
      if (next === undefined || next.due > this.now()) {
        return;
      }
      this.sleepers.shift();
      next.resolve();
      await flushContinuations();
    }
  }
}
