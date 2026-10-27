import type { PrimitiveName, Schema } from './schema.type';

export interface PrimitiveSchema {
  readonly kind: 'primitive';
  readonly name: PrimitiveName;
}

export interface LiteralSchema {
  readonly kind: 'literal';
  readonly value: string | number | boolean | bigint | null | undefined;
}

export interface UnionSchema {
  readonly kind: 'union';
  readonly schemas: readonly Schema[];
}

export interface IntersectionSchema {
  readonly kind: 'intersection';
  readonly schemas: readonly Schema[];
}

export interface ArraySchema {
  readonly kind: 'array';
  readonly items: Schema;
}

export interface TupleSchema {
  readonly kind: 'tuple';
  readonly items: readonly Schema[];
  readonly rest?: Schema | false;
}

export interface MapSchema {
  readonly kind: 'map';
  readonly key: Schema;
  readonly value: Schema;
}

export interface SetSchema {
  readonly kind: 'set';
  readonly item: Schema;
}

export interface ObjectPropertySchema {
  readonly schema: Schema;
  readonly optional?: boolean;
  /**
   * The property comes from a definite assignment assertion (`field!: T`,
   * e.g. Angular-style `@Input() value!: T`): TypeScript itself does not
   * guarantee it is set by the time the instance is first observed. Unlike
   * an ordinary optional (`field?: T`) property — where an explicit
   * `undefined` is deliberately treated as invalid, distinct from absence —
   * a present-but-still-`undefined` value here is tolerated, matching the
   * "trust me, it is assigned later" contract `!` makes with the compiler.
   */
  readonly deferredAssignment?: boolean;
  /**
   * The property is `readonly` in its declared interface/type-literal shape.
   * A plain object/literal value has no "still under construction" phase
   * (unlike a class field, there is no in-between state), so this is enforced
   * as soon as the value crosses a typed boundary, not deferred to any later
   * point. Only set for `PropertySignature` declarations; class fields keep
   * going through `enforceReadonly`.
   */
  readonly readonly?: boolean;
}

export interface SchemaProperties {
  readonly [key: string]: ObjectPropertySchema;
  readonly [key: symbol]: ObjectPropertySchema;
}

export interface ObjectSchema {
  readonly kind: 'object';
  readonly properties: SchemaProperties;
  readonly allowExtraProperties?: boolean;
  readonly extraPropertiesPolicy?: 'error' | 'strip';
  readonly index?: Schema;
  /**
   * The originating class constructor, embedded by the compiler only when
   * the class is declared in the same file as the validation point (a live
   * reference is required for `instanceof`; there is no cross-file lookup).
   * Whether it is actually enforced is decided at validation time by
   * {@link getClassValidationMode} (a per-class decorator override) or,
   * absent one, by {@link strictClassDefault}.
   */
  readonly instanceOf?: Function;
  /**
   * A live reference to a `ValueObject` subclass constructor, embedded the
   * same way `instanceOf` is. When set, this schema does not describe a
   * plain object's declared properties at all (`properties` is irrelevant
   * and should be empty) — it means "a raw string crossing this boundary
   * should be auto-constructed into an instance of this class instead of
   * validated structurally."
   */
  readonly valueObjectCtor?: Function;
  readonly strictClassDefault?: boolean;
  /**
   * True when the class backing this definition carries `@AggregateErrors()`
   * — found statically by the compiler reading the decorator directly off
   * the class declaration, regardless of which file declares the class (see
   * `isAggregateErrorsClass` in `compiler/analysis/type-schema-resolver.ts`).
   * `protectValue` (guards.ts) uses this, for a value crossing a parameter
   * boundary, to collect every violation in the value instead of throwing on
   * the first one — this is the primary detection signal; the runtime
   * `isAggregateErrorsEnabled(value)` check (aggregate-errors.decorator.ts)
   * is an additional fallback for a hand-built instance that never went
   * through the compiler's schema for this type.
   */
  readonly aggregateErrors?: boolean;
}

export interface RefSchema {
  readonly kind: 'ref';
  readonly name: string;
}

export interface DateSchema {
  readonly kind: 'date';
}

export interface FunctionSchema {
  readonly kind: 'function';
}

export interface TemplateLiteralSchema {
  readonly kind: 'templateLiteral';
  /** Regex source (sem delimitadores `/`), já ancorado com ^ e $, compatível com `new RegExp(pattern)`. */
  readonly pattern: string;
}

export interface UnknownSchema {
  readonly kind: 'unknown';
}

export interface NeverSchema {
  readonly kind: 'never';
}
