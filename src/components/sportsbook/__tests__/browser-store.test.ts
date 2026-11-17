import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserStore } from "../browser-store";

test("createBrowserStore survives SecurityError when browser storage throws on getItem/setItem", () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  const throwingStorage = {
    getItem() {
      throw new Error("SecurityError: storage blocked");
    },
    setItem() {
      throw new Error("SecurityError: storage blocked");
    },
    removeItem() {
      throw new Error("SecurityError: storage blocked");
    },
  };

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      sessionStorage: throwingStorage,
      localStorage: throwingStorage,
      addEventListener() {
        throw new Error("SecurityError: listener blocked");
      },
    },
  });

  try {
    const store = createBrowserStore<{ picks: string[] }>({
      area: "session",
      key: `test.blocked.${Date.now()}`,
      fallback: { picks: [] },
      parse: (raw) =>
        typeof raw === "object" && raw !== null && Array.isArray((raw as { picks?: unknown }).picks)
          ? { picks: (raw as { picks: string[] }).picks }
          : null,
    });

    assert.deepEqual(store.read(), { picks: [] });
    let notified = 0;
    const unsub = store.subscribe(() => {
      notified += 1;
    });
    store.update((cur) => ({ picks: [...cur.picks, "sel-1"] }));
    assert.deepEqual(store.read(), { picks: ["sel-1"] });
    assert.equal(notified, 1);
    unsub();
  } finally {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  }
});
