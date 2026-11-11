/** A signal that fires when any of `signals` does, plus a `dispose` that detaches its listeners. */
export type CombinedSignal = { signal: AbortSignal; dispose: () => void };

export const NOOP = (): void => {};

/**
 * `AbortSignal.any` is Node >= 20.3; `engines` allows 20.0. The fallback
 * follows whichever signal fires first and removes its listeners on
 * `dispose` — a long-lived caller signal shared across many calls must not
 * accumulate one listener per call.
 */
export const anySignal = (signals: AbortSignal[]): CombinedSignal => {
  if (typeof AbortSignal.any === "function") {
    return { signal: AbortSignal.any(signals), dispose: NOOP };
  }
  const controller = new AbortController();
  const listeners: Array<[AbortSignal, () => void]> = [];
  const dispose = (): void => {
    for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
    listeners.length = 0;
  };
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const listener = (): void => {
      controller.abort(signal.reason);
      dispose();
    };
    signal.addEventListener("abort", listener, { once: true });
    listeners.push([signal, listener]);
  }
  return { signal: controller.signal, dispose };
};
