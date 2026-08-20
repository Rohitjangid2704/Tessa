import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createListStore, createStore, useStore, useStoreSelector } from "./store";

describe("createStore", () => {
  it("returns the initial state and replaces it", () => {
    const store = createStore({ count: 0 });
    expect(store.getState()).toEqual({ count: 0 });
    store.setState({ count: 2 });
    expect(store.getState()).toEqual({ count: 2 });
    store.update((previous) => ({ count: previous.count + 1 }));
    expect(store.getState()).toEqual({ count: 3 });
  });

  it("notifies subscribers only when the state changes by identity", () => {
    const initial = { count: 0 };
    const store = createStore(initial);
    const listener = vi.fn();
    store.subscribe(listener);

    store.setState(initial);
    expect(listener).not.toHaveBeenCalled();
    store.setState({ count: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stops notifying after unsubscribe and tolerates unsubscribing inside a listener", () => {
    const store = createStore(0);
    const calls: string[] = [];
    const unsubscribeFirst = store.subscribe(() => {
      calls.push("first");
      unsubscribeFirst();
    });
    store.subscribe(() => calls.push("second"));

    store.setState(1);
    store.setState(2);

    expect(calls).toEqual(["first", "second", "second"]);
  });
});

describe("createListStore", () => {
  it("appends, replaces and clears with fresh array identities", () => {
    const list = createListStore<number>();
    const empty = list.getState();
    list.append(1);
    list.appendMany([2, 3]);
    expect(list.getState()).toEqual([1, 2, 3]);
    expect(list.getState()).not.toBe(empty);

    list.replace([9]);
    expect(list.getState()).toEqual([9]);
    list.clear();
    expect(list.getState()).toEqual([]);
  });

  it("starts from the initial items and keeps only the newest within the limit", () => {
    const list = createListStore<number>({ initial: [1, 2, 3, 4], limit: 3 });
    expect(list.getState()).toEqual([2, 3, 4]);
    list.append(5);
    expect(list.getState()).toEqual([3, 4, 5]);
    list.appendMany([6, 7, 8, 9]);
    expect(list.getState()).toEqual([7, 8, 9]);
  });

  it("does not notify for an empty batch", () => {
    const list = createListStore<number>();
    const listener = vi.fn();
    list.subscribe(listener);
    list.appendMany([]);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("store hooks", () => {
  it("useStore re-renders on change", () => {
    const store = createStore({ label: "a" });
    const { result } = renderHook(() => useStore(store));
    expect(result.current.label).toBe("a");

    act(() => store.setState({ label: "b" }));

    expect(result.current.label).toBe("b");
  });

  it("useStoreSelector re-renders only when the selected value changes", () => {
    const store = createStore({ count: 0, other: 0 });
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useStoreSelector(store, (state) => state.count);
    });
    const before = renders;

    act(() => store.update((state) => ({ ...state, other: 1 })));
    expect(renders).toBe(before);

    act(() => store.update((state) => ({ ...state, count: 5 })));
    expect(result.current).toBe(5);
    expect(renders).toBeGreaterThan(before);
  });
});
