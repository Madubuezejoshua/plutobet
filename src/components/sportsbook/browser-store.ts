"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Reading and writing browser storage from a server-rendered component.
 *
 * WHY NOT `useEffect(() => setState(read()), [])`.
 *
 * That is the obvious version and it is wrong twice. It renders once with the
 * fallback, then immediately renders again with the stored value — a cascading
 * render on every mount, which React's own lint rule (`set-state-in-effect`)
 * now refuses. And because each read produces a fresh object, anything
 * comparing snapshots by identity re-renders forever.
 *
 * `useSyncExternalStore` is the supported answer: it hands React a server
 * snapshot to hydrate against and a client snapshot to switch to afterwards,
 * so the markup matches the HTML the server sent and the stored value still
 * arrives without a flash of the wrong state.
 *
 * The value is cached per key so the snapshot is reference-stable, and the
 * cache is invalidated by the `storage` event — which means two tabs of the
 * same account stay in step instead of quietly disagreeing.
 *
 * NOTHING HERE HOLDS MONEY. Browser storage is a convenience: a betslip in
 * progress, a starred competition. Every figure that matters is decided by the
 * server, and a customer who clears their browser loses nothing but a
 * preference.
 */

type Area = "local" | "session";

export interface BrowserStore<T> {
  read: () => T;
  readServer: () => T;
  write: (next: T) => void;
  /** Read-modify-write against the live cache, not a captured render value. */
  update: (change: (current: T) => T) => void;
  subscribe: (onChange: () => void) => () => void;
}

const snapshots = new Map<string, unknown>();
const subscribers = new Map<string, Set<() => void>>();

/** Installed once, and only in a browser. */
let crossTabListenerInstalled = false;

function storageFor(area: Area): Storage | null {
  try {
    return area === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    // Private mode and locked-down browsers throw on access, not on use.
    return null;
  }
}

function notify(cacheKey: string) {
  for (const listener of subscribers.get(cacheKey) ?? []) listener();
}

function installCrossTabListener() {
  if (crossTabListenerInstalled || typeof window === "undefined") return;
  crossTabListenerInstalled = true;
  window.addEventListener("storage", (event) => {
    if (event.key === null) {
      // The whole area was cleared.
      snapshots.clear();
      for (const key of subscribers.keys()) notify(key);
      return;
    }
    for (const cacheKey of [...snapshots.keys()]) {
      if (cacheKey.endsWith(`:${event.key}`)) {
        snapshots.delete(cacheKey);
        notify(cacheKey);
      }
    }
  });
}

/**
 * Declares one stored value.
 *
 * `parse` decides what a stored blob is allowed to become. It is given whatever
 * `JSON.parse` produced — which is to say, anything at all, since a user can
 * edit their own storage — and returns null to reject it. A rejected value is
 * treated as absent rather than thrown: an unreadable betslip is an empty
 * betslip, never a broken page.
 *
 * `fallback` must be a stable reference. It is the server snapshot, and a new
 * object on every call would re-render without end.
 */
export function createBrowserStore<T>(options: {
  area: Area;
  key: string;
  fallback: T;
  parse: (raw: unknown) => T | null;
}): BrowserStore<T> {
  const { area, key, fallback, parse } = options;
  const cacheKey = `${area}:${key}`;

  function read(): T {
    if (snapshots.has(cacheKey)) return snapshots.get(cacheKey) as T;

    let value = fallback;
    const storage = typeof window === "undefined" ? null : storageFor(area);
    const raw = storage?.getItem(key) ?? null;
    if (raw !== null) {
      try {
        const parsed = parse(JSON.parse(raw));
        if (parsed !== null) value = parsed;
      } catch {
        // Corrupt JSON. Treated as absent.
      }
    }
    snapshots.set(cacheKey, value);
    return value;
  }

  function write(next: T): void {
    snapshots.set(cacheKey, next);
    try {
      storageFor(area)?.setItem(key, JSON.stringify(next));
    } catch {
      // Quota, private mode, blocked site data. The value still lives in the
      // cache for this session, so the interface behaves; it just will not
      // survive a reload. Failing loudly over a preference helps nobody.
    }
    notify(cacheKey);
  }

  function subscribe(onChange: () => void): () => void {
    installCrossTabListener();
    const set = subscribers.get(cacheKey) ?? new Set<() => void>();
    set.add(onChange);
    subscribers.set(cacheKey, set);
    return () => {
      set.delete(onChange);
      if (set.size === 0) subscribers.delete(cacheKey);
    };
  }

  function update(change: (current: T) => T): void {
    write(change(read()));
  }

  return { read, readServer: () => fallback, write, update, subscribe };
}

/**
 * Subscribes a component to a stored value.
 *
 * Returns the updater as well as the setter, because most callers want
 * read-modify-write and doing that from a captured render value loses
 * concurrent changes — including one made in another tab a moment earlier.
 */
export function useBrowserStore<T>(
  store: BrowserStore<T>,
): [T, (next: T) => void, (change: (current: T) => T) => void] {
  const value = useSyncExternalStore(store.subscribe, store.read, store.readServer);
  const write = useCallback((next: T) => store.write(next), [store]);
  const update = useCallback((change: (current: T) => T) => store.update(change), [store]);
  return [value, write, update];
}

/** The common case: a set of ids, stored as an array of strings. */
export function createIdSetStore(area: Area, key: string): BrowserStore<readonly string[]> {
  return createBrowserStore<readonly string[]>({
    area,
    key,
    fallback: EMPTY_IDS,
    parse: (raw) =>
      Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : null,
  });
}

/** One frozen array, shared by every id-set store as its server snapshot. */
const EMPTY_IDS: readonly string[] = Object.freeze([]);
