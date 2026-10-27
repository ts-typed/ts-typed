import { AggregateStrictTypeError } from './aggregate-strict-type-error.class';
import type { StrictTypeErrorInfo } from './strict-type-error-info.interface';
import { StrictTypeError } from './strict-type-error.class';

/**
 * Thrown by `protectValue` (guards.ts) instead of a plain `StrictTypeError`
 * when the value crossing an array parameter boundary has one or more
 * elements that are instances of an `AggregateErrors()`-decorated class with
 * violations: one nested `AggregateStrictTypeError` per invalid element,
 * instead of stopping at the first one.
 *
 * Extends `StrictTypeError` (not `AggregateStrictTypeError`, and not a
 * parallel hierarchy) so every existing `instanceof StrictTypeError` check —
 * application `try`/`catch`, `@ts-typed/nestjs`'s `StrictTypeErrorFilter` —
 * keeps working unchanged: it sees the FIRST element error's FIRST
 * violation's fields through the inherited properties. The full per-element
 * breakdown is additionally available as `errors`.
 */
export class ArrayAggregateStrictTypeError extends StrictTypeError {
  public readonly errors: readonly AggregateStrictTypeError[];

  public constructor(errors: readonly AggregateStrictTypeError[]) {
    if (errors.length === 0) {
      throw new Error('ArrayAggregateStrictTypeError requires at least one element error');
    }
    super(errors[0].errors[0]);
    this.name = 'ArrayAggregateStrictTypeError';
    this.errors = errors;
    this.message = `Validation failed: ${errors.length} invalid array element(s)`;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  public override toJSON(): StrictTypeErrorInfo & { errors: Array<StrictTypeErrorInfo & { errors: StrictTypeErrorInfo[] }> } {
    return {
      ...super.toJSON(),
      errors: this.errors.map((error) => error.toJSON()),
    };
  }
}
