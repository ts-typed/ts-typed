import type {
  ArraySchema,
  DateSchema,
  FunctionSchema,
  IntersectionSchema,
  LiteralSchema,
  MapSchema,
  NeverSchema,
  NumericConstraintSchema,
  ObjectSchema,
  SetSchema,
  PrimitiveSchema,
  RefSchema,
  StringLengthSchema,
  TemplateLiteralSchema,
  TupleSchema,
  UnionSchema,
  UnknownSchema,
} from './schema.interface';

export type PrimitiveName =
  | 'string'
  | 'number'
  | 'boolean'
  | 'bigint'
  | 'symbol'
  | 'object'
  | 'function'
  | 'null'
  | 'undefined';

export type Schema =
  | PrimitiveSchema
  | LiteralSchema
  | UnionSchema
  | IntersectionSchema
  | ArraySchema
  | TupleSchema
  | MapSchema
  | SetSchema
  | ObjectSchema
  | RefSchema
  | DateSchema
  | FunctionSchema
  | TemplateLiteralSchema
  | NumericConstraintSchema
  | StringLengthSchema
  | UnknownSchema
  | NeverSchema;
