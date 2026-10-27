import { isAggregateErrorsEnabled } from './aggregate-errors.decorator';
import { AggregateStrictTypeError } from './aggregate-strict-type-error.class';
import type { StrictTypeErrorInfo } from './strict-type-error-info.interface';

const windows = new WeakMap<object, StrictTypeErrorInfo[]>();

/**
 * A handler invoked when an `@AggregateErrors()` instance's window is closed
 * by garbage collection (i.e. the instance was constructed, buffered one or
 * more violations, and then became unreachable without ever crossing a real
 * parameter boundary) while it still held unread violations. See
 * `setAggregateWindowLeakHandler`.
 */
export type AggregateWindowLeakHandler = (violations: readonly StrictTypeErrorInfo[]) => void;

let leakHandler: AggregateWindowLeakHandler = (violations) => {
  // eslint-disable-next-line no-console -- default leak-reporting path; see setAggregateWindowLeakHandler
  console.error(
    `[ts-typed] AggregateErrors: an instance was garbage-collected with ${violations.length} ` +
      'buffered violation(s) that no parameter crossing ever read. This usually means a ' +
      'decorated instance was constructed but never passed through a typed parameter ' +
      '(or was discarded before it could be). Call setAggregateWindowLeakHandler() to ' +
      'customize this reporting.',
  );
};

/**
 * Overrides how a "leaked" aggregate window (closed by GC, with unread
 * violations) is reported. Defaults to a `console.error` warning. The
 * handler receives the buffered violations; it must not throw (there is no
 * synchronous caller to catch it) and should not assume any particular
 * timing (GC is non-deterministic and may run long after the violations
 * were produced, or not at all before process exit).
 */
export function setAggregateWindowLeakHandler(handler: AggregateWindowLeakHandler): void {
  leakHandler = handler;
}

const registry = new FinalizationRegistry<StrictTypeErrorInfo[]>((violations) => {
  if (violations.length > 0) {
    leakHandler(violations);
  }
});

/**
 * Opens an "aggregate window" for `instance`, if (and only if) it is an
 * instance of an `@AggregateErrors()`-decorated class. Called unconditionally
 * by the compiler at the end of every named class's most-derived
 * construction (see `create-contract-transformer.ts`'s
 * `createMostDerivedConstructionStatements`) — this function, not the
 * transformer, decides whether anything actually happens, exactly like
 * `isServerPopulated`/`isExtraPropertiesAllowed` already decide their own
 * classes' behavior from the runtime value rather than compile-time gating.
 *
 * While a window is open, `collectIfAggregating` collects violations instead
 * of signaling "fall back to throwing" — see that function and
 * `takeAggregateWindowViolations` for the other two thirds of this
 * mechanism. A window that no real parameter crossing closes is closed by
 * garbage collection instead: this registers `instance` with a
 * `FinalizationRegistry` whose callback reports (via `leakHandler`, see
 * `setAggregateWindowLeakHandler`) any violations still buffered once
 * `instance` becomes unreachable. GC-based closing cannot race a later
 * `await` the way a microtask-based close could — nothing can collect
 * `instance` while it (or the buffer, via a live reference held elsewhere)
 * is still reachable, including across an `await` — but it is also
 * non-deterministic: it may run arbitrarily late, or not at all before
 * process exit, which is why the finalizer reports rather than throws.
 */
export function beginAggregateWindow(instance: object): void {
  if (!isAggregateErrorsEnabled(instance)) {
    return;
  }
  const buffer: StrictTypeErrorInfo[] = [];
  windows.set(instance, buffer);
  // heldValue is the SAME array `collectIfAggregating` pushes into below —
  // not a snapshot — so the finalizer callback sees everything collected
  // up to the moment `instance` became unreachable.
  registry.register(instance, buffer, instance);
}

/**
 * Returns `true` when a window is currently open for `instance` — i.e. a
 * prior `beginAggregateWindow(instance)` call has not yet been matched by
 * `takeAggregateWindowViolations(instance)`. Callers on a hot path (such as
 * `setGuardedValue` in guards.ts) use this to decide, once and up front,
 * whether to take the collecting path at all, rather than always running the
 * non-throwing collecting check and then deciding what to do with its
 * result — the latter would change observable behavior (re-reading getters,
 * extra traversal cost) even when no window is open.
 */
export function isAggregating(instance: object): boolean {
  return windows.has(instance);
}

/**
 * If a window is open for `instance`, records `violation` in it and returns
 * `true` — the caller must NOT throw and must NOT store the value that
 * produced this violation (the field keeps whatever it already held).
 * Returns `false` when no window is open, meaning the caller's normal
 * fail-fast behavior (throw immediately) is unchanged from today.
 */
export function collectIfAggregating(instance: object, violation: StrictTypeErrorInfo): boolean {
  const buffer = windows.get(instance);
  if (buffer === undefined) {
    return false;
  }
  buffer.push(violation);
  return true;
}

/**
 * Closes the window for `instance` (so any later field write on it goes back
 * to ordinary fail-fast) and returns everything collected while it was open
 * — possibly an empty array, if the window was open but nothing failed.
 * Returns `undefined` when no window was ever open for this instance, which
 * is how `protectValue` (guards.ts) tells "nothing to merge" apart from
 * "the window was open and genuinely found zero violations."
 *
 * Also unregisters `instance` from the finalization registry: a real
 * crossing already consumed the buffer, so there is nothing left to report
 * when `instance` is eventually collected.
 */
export function takeAggregateWindowViolations(instance: object): StrictTypeErrorInfo[] | undefined {
  const buffer = windows.get(instance);
  if (buffer === undefined) {
    return undefined;
  }
  windows.delete(instance);
  registry.unregister(instance);
  return buffer;
}

/**
 * Explicitly and synchronously closes `instance`'s aggregate window —
 * use this immediately after manual population ends (e.g. right after a
 * `class-transformer` `plainToInstance()` call, or after hand-setting every
 * field) when nothing will cross `instance` through a typed parameter
 * boundary to close the window for you.
 *
 * Unlike the GC-driven close in `beginAggregateWindow`'s finalizer — which
 * cannot usefully `throw` because it has no synchronous caller, and may run
 * arbitrarily late or not at all before process exit — this close point is
 * caller-determined, so it is race-free by construction and can throw
 * immediately. Throws `AggregateStrictTypeError` if any violations were
 * buffered; does nothing (no throw) if the window was open but empty, or if
 * no window was open at all (including instances of classes not decorated
 * with `@AggregateErrors()`).
 */
export function closeAggregateWindowOrThrow(instance: object): void {
  const violations = takeAggregateWindowViolations(instance);
  if (violations !== undefined && violations.length > 0) {
    throw new AggregateStrictTypeError(violations);
  }
}
