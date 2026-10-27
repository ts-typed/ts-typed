export { StrictTypeError } from './strict-type-error.class';
export { AggregateStrictTypeError } from './aggregate-strict-type-error.class';
export { ArrayAggregateStrictTypeError } from './array-aggregate-strict-type-error.class';
export type { StrictTypeErrorCode } from './strict-type-error-code.type';
export type { StrictTypeErrorInfo } from './strict-type-error-info.interface';
export {
  ExtraProperties,
  getExtraPropertiesPolicy,
} from './extra-properties.decorator';
export { ServerPopulated, isServerPopulated } from './server-populated.decorator';
export { AggregateErrors, isAggregateErrorsEnabled } from './aggregate-errors.decorator';
export {
  beginAggregateWindow,
  collectIfAggregating,
  isAggregating,
  setAggregateWindowLeakHandler,
  takeAggregateWindowViolations,
} from './aggregate-window';
export type { AggregateWindowLeakHandler } from './aggregate-window';
export { TypeErrorResponse, getTypeErrorResponse } from './type-error-response.decorator';
export type { TypeErrorResponseOptions } from './type-error-response.decorator';
export {
  StrictClass,
  StructuralClass,
  getClassValidationMode,
} from './strict-class.decorator';
export type { ClassValidationMode } from './strict-class.decorator';
export { SchemaRegistry } from './schema-registry.class';
export type { PrimitiveName, Schema } from './schema.type';
export type {
  ArraySchema,
  IntersectionSchema,
  LiteralSchema,
  NeverSchema,
  ObjectPropertySchema,
  ObjectSchema,
  PrimitiveSchema,
  RefSchema,
  TupleSchema,
  UnionSchema,
  UnknownSchema,
} from './schema.interface';
export { assertValue, assertValueCollecting } from './assert-value';
export type { AssertionContext } from './assertion-context.interface';
export {
  protectValue,
  installFieldGuard,
  lockReadonlyField,
  lockRequiredField,
  withDeferredReadonlyLock,
} from './guards';
export { protectOptimizedImmutableValue } from './protect-optimized-immutable-value';
export type { FieldGuardOptions } from './guards';
export type { TTOptImmut } from './tt-opt-immut.type';
export { ValueObject } from './value-object.class';
export type { ValueObjectErrorContext } from './value-object.class';
