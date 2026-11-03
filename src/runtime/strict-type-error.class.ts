import type { StrictTypeErrorInfo } from './strict-type-error-info.interface';
import type { StrictTypeErrorCode } from './strict-type-error-code.type';

export class StrictTypeError extends TypeError {
  public readonly code: StrictTypeErrorCode;
  public readonly className?: string;
  public readonly functionName?: string;
  public readonly isServerPopulated?: boolean;
  public readonly typeErrorResponseMessage?: string;
  public readonly typeErrorResponseStatus?: number;
  public readonly contractKind: StrictTypeErrorInfo['contractKind'];
  public readonly propertyPath: string;
  public readonly expected: string;
  public readonly received: string;
  public readonly operation: StrictTypeErrorInfo['operation'];
  public readonly candidates?: readonly StrictTypeErrorInfo[];

  public constructor(info: StrictTypeErrorInfo) {
    super(`${info.propertyPath} expected ${info.expected}, received ${info.received}`);
    this.name = 'StrictTypeError';
    this.code = info.code;
    this.className = info.className;
    this.functionName = info.functionName;
    this.isServerPopulated = info.isServerPopulated;
    this.typeErrorResponseMessage = info.typeErrorResponseMessage;
    this.typeErrorResponseStatus = info.typeErrorResponseStatus;
    this.contractKind = info.contractKind;
    this.propertyPath = info.propertyPath;
    this.expected = info.expected;
    this.received = info.received;
    this.operation = info.operation;
    this.candidates = info.candidates;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  public toJSON(): StrictTypeErrorInfo {
    return {
      code: this.code,
      ...(this.className === undefined ? {} : { className: this.className }),
      ...(this.functionName === undefined ? {} : { functionName: this.functionName }),
      contractKind: this.contractKind,
      propertyPath: this.propertyPath,
      expected: this.expected,
      received: this.received,
      operation: this.operation,
      ...(this.candidates === undefined ? {} : { candidates: this.candidates }),
    };
  }
}
