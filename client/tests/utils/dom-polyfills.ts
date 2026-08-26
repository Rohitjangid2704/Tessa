class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): unknown[] {
    return [];
  }
}

function defineIfMissing(target: object, name: string, value: unknown): void {
  if (typeof Reflect.get(target, name) !== "function") {
    Object.defineProperty(target, name, { configurable: true, writable: true, value });
  }
}

function installDomPolyfills(): void {
  if (typeof window === "undefined") {
    return;
  }
  defineIfMissing(window, "ResizeObserver", NoopObserver);
  defineIfMissing(window, "IntersectionObserver", NoopObserver);
  defineIfMissing(window, "matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
  defineIfMissing(Element.prototype, "scrollIntoView", () => {});
  defineIfMissing(Element.prototype, "hasPointerCapture", () => false);
  defineIfMissing(Element.prototype, "setPointerCapture", () => {});
  defineIfMissing(Element.prototype, "releasePointerCapture", () => {});
}

installDomPolyfills();
