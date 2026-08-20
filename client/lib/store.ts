import { useSyncExternalStore } from "react";

export type StoreListener = () => void;

export interface ReadableStore<State> {
  getState: () => State;
  subscribe: (listener: StoreListener) => () => void;
}

export interface Store<State> extends ReadableStore<State> {
  setState: (next: State) => void;
  update: (updater: (previous: State) => State) => void;
}

export function createStore<State>(initial: State): Store<State> {
  let state = initial;
  const listeners = new Set<StoreListener>();

  function setState(next: State): void {
    if (Object.is(next, state)) {
      return;
    }
    state = next;
    for (const listener of [...listeners]) {
      listener();
    }
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setState,
    update: (updater) => setState(updater(state)),
  };
}

export function useStore<State>(store: ReadableStore<State>): State {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

export function useStoreSelector<State, Selected>(
  store: ReadableStore<State>,
  selector: (state: State) => Selected,
): Selected {
  const read = () => selector(store.getState());
  return useSyncExternalStore(store.subscribe, read, read);
}

export interface ListStore<Item> extends ReadableStore<readonly Item[]> {
  append: (item: Item) => void;
  appendMany: (items: readonly Item[]) => void;
  replace: (items: readonly Item[]) => void;
  clear: () => void;
}

export interface ListStoreOptions<Item> {
  initial?: readonly Item[];
  limit?: number;
}

export function createListStore<Item>(options: ListStoreOptions<Item> = {}): ListStore<Item> {
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const store = createStore<readonly Item[]>(options.initial?.slice(-limit) ?? []);

  function appendMany(items: readonly Item[]): void {
    if (items.length === 0) {
      return;
    }
    store.update((previous) => [...previous, ...items].slice(-limit));
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    append: (item) => appendMany([item]),
    appendMany,
    replace: (items) => store.setState(items.slice(-limit)),
    clear: () => store.setState([]),
  };
}
