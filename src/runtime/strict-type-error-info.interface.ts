import type { AssertionContext } from './assertion-context.interface';
import type { StrictTypeErrorCode } from './strict-type-error-code.type';

export interface StrictTypeErrorInfo {
  readonly code: StrictTypeErrorCode;
  readonly className?: string;
  readonly functionName?: string;
  readonly isServerPopulated?: boolean;
  readonly typeErrorResponseMessage?: string;
  readonly typeErrorResponseStatus?: number;
  readonly contractKind: AssertionContext['contractKind'];
  readonly propertyPath: string;
  readonly expected: string;
  readonly received: string;
  readonly operation: AssertionContext['operation'];
  /**
   * For a `code: 'TYPE_MISMATCH'` reported against a union (`expected:
   * 'union'`), the reason each member schema, in declaration order, was
   * rejected — one or more violations per member, from validating the
   * value against that member alone. Absent for every other report.
   */
  readonly candidates?: readonly StrictTypeErrorInfo[];
}
