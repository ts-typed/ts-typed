import type { StrictTypeErrorInfo } from './strict-type-error-info.interface';
import { StrictTypeError } from './strict-type-error.class';

/**
 * Thrown by `protectValue` (guards.ts) instead of a plain `StrictTypeError`
 * when the value crossing a parameter boundary is an instance of an
 * `AggregateErrors()`-decorated class: every violation found in it, at any
 * depth, instead of only the first one.
 *
 * Extends `StrictTypeError` (not a parallel hierarchy) so every existing
 * `instanceof StrictTypeError` check — application `try`/`catch`,
 * `@ts-typed/nestjs`'s `StrictTypeErrorFilter` — keeps working unchanged: it
 * sees the FIRST violation's fields through the inherited properties. The
 * full list is additionally available as `errors`.
 */
export class AggregateStrictTypeError extends StrictTypeError {
  public readonly errors: readonly StrictTypeErrorInfo[];

  /**
   * The original array index this error's element occupied, when this
   * instance was produced by the array-of-decorated-DTOs aggregation branch
   * (see `ArrayAggregateStrictTypeError`). `undefined` for a single-object
   * aggregation (the normal, non-array `@AggregateErrors()` crossing), which
   * never passes this argument.
   */
  public readonly elementIndex?: number;

  public constructor(errors: readonly StrictTypeErrorInfo[], elementIndex?: number) {
    if (errors.length === 0) {
      throw new Error('AggregateStrictTypeError requires at least one violation');
    }
    super(errors[0]);
    this.name = 'AggregateStrictTypeError';
    this.errors = errors;
    this.elementIndex = elementIndex;
    // Error#message is a plain writable property (not readonly), so this
    // overwrites the single-violation message StrictTypeError's own
    // constructor just built from errors[0] — without it, printing this
    // exception (or @ts-typed/nestjs's resolveMessage() falling back to
    // .message) would misleadingly show only the first of several violations.
    this.message = `Validation failed: ${errors.length} error(s)`;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  public override toJSON(): StrictTypeErrorInfo & { errors: StrictTypeErrorInfo[]; elementIndex?: number } {
    return {
      ...super.toJSON(),
      errors: [...this.errors],
      ...(this.elementIndex === undefined ? {} : { elementIndex: this.elementIndex }),
    };
  }
}
