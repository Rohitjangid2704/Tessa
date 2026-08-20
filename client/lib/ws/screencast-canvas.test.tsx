import { StrictMode } from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_SESSION_ID } from "@/tests/utils/stream-fixtures";
import { FrameBus, type TileSink } from "./frame-bus";
import { ScreencastCanvas } from "./screencast-canvas";

type ObserverCallback = (entries: Array<Pick<IntersectionObserverEntry, "isIntersecting">>) => void;

class ControlledObserver {
  static instances: ControlledObserver[] = [];
  disconnected = false;
  observed: Element[] = [];

  constructor(
    readonly callback: ObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    ControlledObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.observed.push(element);
  }

  unobserve(): void {}

  disconnect(): void {
    this.disconnected = true;
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  emit(isIntersecting: boolean): void {
    this.callback([{ isIntersecting }]);
  }
}

const drawImage = vi.fn();
const getContext = vi.fn(() => ({ drawImage }));

beforeEach(() => {
  ControlledObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", ControlledObserver);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    getContext as unknown as HTMLCanvasElement["getContext"],
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  drawImage.mockClear();
  getContext.mockClear();
});

function spyOnBus() {
  const bus = new FrameBus({ scheduleFrame: () => () => {} });
  const sinks = new Map<string, TileSink>();
  const attach = vi.spyOn(bus, "attach").mockImplementation((sessionId, sink) => {
    sinks.set(sessionId, sink);
    return () => sinks.delete(sessionId);
  });
  const visible = vi.spyOn(bus, "setTileVisible");
  const mode = vi.spyOn(bus, "setTileMode");
  return { bus, sinks, attach, visible, mode };
}

describe("ScreencastCanvas", () => {
  it("renders a labelled canvas at the default grid size", () => {
    const { bus } = spyOnBus();
    render(
      <ScreencastCanvas bus={bus} sessionId={FIXTURE_SESSION_ID} label="Live view of tile 1" />,
    );

    const canvas = screen.getByRole("img", { name: "Live view of tile 1" });
    expect(canvas.tagName).toBe("CANVAS");
    expect(canvas).toHaveAttribute("width", "640");
    expect(canvas).toHaveAttribute("height", "400");
    expect(canvas).toHaveAttribute("data-session-id", FIXTURE_SESSION_ID);
  });

  it("attaches to the bus, observes visibility and reports intersection changes", () => {
    const { bus, attach, visible } = spyOnBus();
    render(<ScreencastCanvas bus={bus} sessionId={FIXTURE_SESSION_ID} label="tile" />);

    expect(attach).toHaveBeenCalledWith(FIXTURE_SESSION_ID, expect.any(Object));
    const [observer] = ControlledObserver.instances;
    expect(observer?.observed).toHaveLength(1);
    expect(observer?.options?.threshold).toBe(0.1);

    observer?.emit(true);
    observer?.emit(false);

    expect(visible.mock.calls).toEqual([
      [FIXTURE_SESSION_ID, true],
      [FIXTURE_SESSION_ID, false],
    ]);
  });

  it("draws painted bitmaps and resizes the canvas only when the frame size changes", () => {
    const { bus, sinks } = spyOnBus();
    render(<ScreencastCanvas bus={bus} sessionId={FIXTURE_SESSION_ID} label="tile" />);
    const canvas = screen.getByRole("img");
    const sink = sinks.get(FIXTURE_SESSION_ID);
    const bitmap = { width: 800, height: 500 } as unknown as ImageBitmap;

    sink?.paint(bitmap, { frameSeq: 1, width: 800, height: 500, pageUrl: null });
    expect(canvas).toHaveAttribute("width", "800");
    expect(canvas).toHaveAttribute("height", "500");
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0);

    const widthSetter = vi.spyOn(canvas as HTMLCanvasElement, "width", "set");
    sink?.paint(bitmap, { frameSeq: 2, width: 800, height: 500, pageUrl: null });
    expect(widthSetter).not.toHaveBeenCalled();
    expect(drawImage).toHaveBeenCalledTimes(2);
  });

  it("applies the requested mode and updates it", () => {
    const { bus, mode } = spyOnBus();
    const { rerender } = render(
      <ScreencastCanvas bus={bus} sessionId={FIXTURE_SESSION_ID} mode="focus" label="tile" />,
    );
    rerender(
      <ScreencastCanvas bus={bus} sessionId={FIXTURE_SESSION_ID} mode="grid" label="tile" />,
    );

    expect(mode.mock.calls).toEqual([
      [FIXTURE_SESSION_ID, "focus"],
      [FIXTURE_SESSION_ID, "grid"],
    ]);
  });

  it("detaches and disconnects the observer on unmount", () => {
    const { bus, sinks } = spyOnBus();
    const { unmount } = render(
      <ScreencastCanvas bus={bus} sessionId={FIXTURE_SESSION_ID} label="tile" />,
    );
    expect(sinks.has(FIXTURE_SESSION_ID)).toBe(true);

    unmount();

    expect(sinks.has(FIXTURE_SESSION_ID)).toBe(false);
    expect(ControlledObserver.instances.every((observer) => observer.disconnected)).toBe(true);
  });

  it("ends a StrictMode double mount attached exactly once", () => {
    const { bus, sinks } = spyOnBus();
    render(
      <StrictMode>
        <ScreencastCanvas bus={bus} sessionId={FIXTURE_SESSION_ID} label="tile" />
      </StrictMode>,
    );

    expect(sinks.size).toBe(1);
    expect(ControlledObserver.instances.filter((observer) => !observer.disconnected)).toHaveLength(
      1,
    );
  });

  it("passes extra canvas props through and merges the class name", () => {
    const { bus } = spyOnBus();
    render(
      <ScreencastCanvas
        bus={bus}
        sessionId={FIXTURE_SESSION_ID}
        label="tile"
        className="rounded-none"
        data-testid="canvas"
      />,
    );

    expect(screen.getByTestId("canvas")).toHaveClass("rounded-none", "w-full");
  });
});
