import { isAggregateErrorsEnabled } from './aggregate-errors.decorator';
import { AggregateStrictTypeError } from './aggregate-strict-type-error.class';
import type { StrictTypeErrorInfo } from './strict-type-error-info.interface';

const windows = new WeakMap<object, StrictTypeErrorInfo[]>();

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
 * mechanism. A window that no real parameter crossing closed is auto-closed on
 * the next microtask by `autoCloseWindow` (see below).
 */
export function beginAggregateWindow(instance: object): void {
  if (!isAggregateErrorsEnabled(instance)) {
    return;
  }
  windows.set(instance, []);
  queueMicrotask(() => autoCloseWindow(instance));
}

/**
 * Closes `instance`'s window on the microtask after construction if nothing
 * else closed it first. A real parameter crossing (`takeAggregateWindowViolations`,
 * called from `assert-value.ts` and `guards/guards.ts`) always wins the race,
 * since it runs synchronously before any microtask drains — this function is a
 * no-op in that case. Otherwise, this is the only thing that will ever read out
 * what was buffered, so it throws here (asynchronously) instead of letting
 * the violations go unread.
 */
function autoCloseWindow(instance: object): void {
  const violations = takeAggregateWindowViolations(instance);
  if (!violations?.length) {
    return;
  }
  throw new AggregateStrictTypeError(violations);
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
 */
export function takeAggregateWindowViolations(instance: object): StrictTypeErrorInfo[] | undefined {
  const buffer = windows.get(instance);
  if (buffer === undefined) {
    return undefined;
  }
  windows.delete(instance);
  return buffer;
}
