import { useCallback, useRef, useState } from 'react';

/**
 * The page's one-at-a-time lock, held above the transport services.
 *
 * `TransferService` has its own lock, but the page needs one too: the restore
 * confirmation, the advanced drawer and every panel share these sends, and two
 * of them starting together is the failure the transport lock exists to catch.
 *
 * `isBusy` reads the ref, not the state, because state lags a click by a render:
 * a second send dispatched in the same tick would otherwise see `false`.
 */
export type BusyLock = {
  readonly busy: boolean;
  isBusy(): boolean;
  /** Runs the task under the lock, or returns undefined when it is already held. */
  run<T>(task: () => Promise<T>): Promise<T | undefined>;
  /** For work that owns its transfers elsewhere, such as the advanced drawer. */
  set(value: boolean): void;
};

export function useBusyLock(): BusyLock {
  const [busy, setBusy] = useState(false);
  const held = useRef(false);

  const isBusy = useCallback(() => held.current, []);

  const run = useCallback(async <T>(task: () => Promise<T>): Promise<T | undefined> => {
    if (held.current) return undefined;

    held.current = true;
    setBusy(true);
    try {
      return await task();
    } finally {
      held.current = false;
      setBusy(false);
    }
  }, []);

  const set = useCallback((value: boolean) => {
    held.current = value;
    setBusy(value);
  }, []);

  return { busy, isBusy, run, set };
}
