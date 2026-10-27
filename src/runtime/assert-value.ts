import type { AssertionContext } from './assertion-context.interface';
import { takeAggregateWindowViolations } from './aggregate-window';
import { getExtraPropertiesPolicy } from './extra-properties.decorator';
import { SchemaRegistry } from './schema-registry.class';
import { SchemaMetadataCache } from './schema-metadata-cache.class';
import { isServerPopulated } from './server-populated.decorator';
import { getClassValidationMode } from './strict-class.decorator';
import { getTypeErrorResponse } from './type-error-response.decorator';
import type {
  ArraySchema,
  IntersectionSchema,
  MapSchema,
  ObjectPropertySchema,
  ObjectSchema,
  RefSchema,
  SetSchema,
  TupleSchema,
  UnionSchema,
} from './schema.interface';
import type { PrimitiveName, Schema } from './schema.type';
import { StrictTypeError } from './strict-type-error.class';
import type { StrictTypeErrorInfo } from './strict-type-error-info.interface';
import { createTraversalSession } from './traversal-session';
import type { TraversalSession } from './traversal-session';

interface ValidationState {
  readonly registry: SchemaRegistry;
  readonly visited: Map<object, Set<Schema>>;
  readonly metadataCache: SchemaMetadataCache;
  readonly protectionPlan?: TraversalSession['protectionPlan'];
  /**
   * When set, a violation is pushed here instead of being thrown immediately,
   * and validation continues on to the next sibling (next object property,
   * next array/tuple item, next Map/Set entry, etc.) instead of aborting the
   * whole traversal. Absent (the default) means every existing fail-fast
   * behavior is unchanged: the first violation throws `StrictTypeError`
   * immediately, via `report()` below. `succeeds()`'s internal `cloneState()`
   * deliberately omits this field, so a union's candidate probing always
   * runs fail-fast even when the outer traversal is collecting — a
   * candidate's failure is discardable, not a real violation.
   */
  readonly collector?: StrictTypeErrorInfo[];
  /**
   * Extra properties the `'strip'` policy decided to delete. Deletion is
   * deferred until the whole assertion has succeeded (see
   * {@link commitPendingStrips}) — the same "check the whole graph first,
   * mutate only afterwards" rule the 0.1.35 `TTOptImmut` atomic-freeze fix
   * established — so a union candidate that is only being probed, or a call
   * that ultimately rejects because of some sibling field, never leaves the
   * caller's input partially stripped.
   */
  readonly pendingStrips: PendingStrip[];
  /**
   * Set while probing union candidates for an exact match: a would-be strip
   * is reported as `EXTRA_PROPERTY` instead (exactly like `'error'`), and
   * `suppressed` records that it happened so the union knows a second,
   * strip-tolerant pass is worth running. This keeps branch selection
   * independent of the extra-properties policy.
   */
  readonly strictExtras?: { suppressed: boolean };
}

interface PendingStrip {
  readonly target: object;
  readonly key: PropertyKey;
  readonly context: AssertionContext;
  readonly path: string;
}

const MAX_ARRAY_INDEX = 4_294_967_294;

export function assertValue(
  schema: Schema,
  value: unknown,
  context: AssertionContext,
): void {
  assertValueWithSession(schema, value, context, createTraversalSession(context));
}

/** Internal form used when validation is followed by protection. */
export function assertValueWithSession(
  schema: Schema,
  value: unknown,
  context: AssertionContext,
  session: TraversalSession,
): void {
  const state: ValidationState = {
    registry: session.registry,
    visited: new Map<object, Set<Schema>>(),
    metadataCache: session.metadataCache,
    protectionPlan: session.protectionPlan,
    pendingStrips: [],
  };

  validate(schema, value, context, context.propertyPath, state);
  commitPendingStrips(state);
}

export function assertValueCollecting(
  schema: Schema,
  value: unknown,
  context: AssertionContext,
): StrictTypeErrorInfo[] {
  return assertValueCollectingWithSession(schema, value, context, createTraversalSession(context));
}

export function assertValueCollectingWithSession(
  schema: Schema,
  value: unknown,
  context: AssertionContext,
  session: TraversalSession,
): StrictTypeErrorInfo[] {
  const { violations, commit } = assertValueCollectingDeferred(schema, value, context, session);
  if (violations.length === 0) {
    commit();
  }
  return violations;
}

/**
 * Like {@link assertValueCollectingWithSession}, but leaves the decision of
 * whether to commit pending strips to the caller instead of deciding it from
 * this collector alone. Needed when a caller combines these violations with
 * another violation source collected outside this call (e.g. an aggregate
 * window) — committing here, before that combination happens, would strip
 * the value even when the combined result is a rejection.
 */
export function assertValueCollectingDeferred(
  schema: Schema,
  value: unknown,
  context: AssertionContext,
  session: TraversalSession,
): { readonly violations: StrictTypeErrorInfo[]; readonly commit: () => void } {
  const collector: StrictTypeErrorInfo[] = [];
  const state: ValidationState = {
    registry: session.registry,
    visited: new Map<object, Set<Schema>>(),
    metadataCache: session.metadataCache,
    protectionPlan: session.protectionPlan,
    collector,
    pendingStrips: [],
  };

  validate(schema, value, context, context.propertyPath, state);
  return { violations: collector, commit: () => commitPendingStrips(state) };
}

function validate(
  schema: Schema,
  value: unknown,
  context: AssertionContext,
  path: string,
  state: ValidationState,
): void {
  if (schema.kind === 'ref') {
    validate(resolveReference(schema, state.registry), value, context, path, state);
    return;
  }

  if (isReferenceValue(value) && traversesReferenceValue(schema)) {
    const windowViolations = takeAggregateWindowViolations(value);
    if (windowViolations !== undefined && windowViolations.length > 0) {
      if (state.collector !== undefined) {
        state.collector.push(...windowViolations);
      } else {
        throw new StrictTypeError(windowViolations[0]);
      }
    }
  }

  if (isReferenceValue(value) && wasVisited(value, schema, state.visited)) {
    return;
  }

  if (state.protectionPlan !== undefined && isReferenceValue(value)) {
    state.protectionPlan.push({
      schema,
      value,
      context: { ...context, propertyPath: path },
    });
  }

  switch (schema.kind) {
    case 'unknown':
      return;
    case 'never':
      report(state, context, path, 'never', value, 'TYPE_MISMATCH');
      return;
    case 'function':
      if (typeof value !== 'function') {
        report(state, context, path, 'function', value, 'TYPE_MISMATCH');
      }
      return;
    case 'templateLiteral':
      if (typeof value !== 'string' || !matchesTemplateLiteral(schema.pattern, value)) {
        report(state, context, path, `template literal matching /${schema.pattern}/`, value, 'TYPE_MISMATCH');
      }
      return;
    case 'date':
      // An `Invalid Date` is still a Date instance; reject it here with a
      // contract error instead of letting it fail later with a RangeError.
      if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        report(state, context, path, 'Date', value, 'TYPE_MISMATCH');
      }
      return;
    case 'primitive':
      if (!matchesPrimitive(schema.name, value)) {
        report(state, context, path, schema.name, value, 'TYPE_MISMATCH');
      }
      return;
    case 'literal':
      if (schema.value !== value) {
        report(state, context, path, literalName(schema.value), value, 'TYPE_MISMATCH');
      }
      return;
    case 'union':
      validateUnion(schema, value, context, path, state);
      return;
    case 'intersection':
      validateIntersection(schema, value, context, path, state);
      return;
    case 'array':
      validateArray(schema, value, context, path, state);
      return;
    case 'tuple':
      validateTuple(schema, value, context, path, state);
      return;
    case 'map':
      validateMap(schema, value, context, path, state);
      return;
    case 'set':
      validateSet(schema, value, context, path, state);
      return;
    case 'object':
      validateObject(schema, value, context, path, state);
  }
}

function validateUnion(
  schema: UnionSchema,
  value: unknown,
  context: AssertionContext,
  path: string,
  state: ValidationState,
): void {
  // Branch selection never depends on the extra-properties policy: the first
  // pass treats every would-be strip as a mismatch (exactly like `'error'`),
  // so a value that matches some candidate as-is always picks that candidate.
  // Only when no candidate matches as-is, and at least one rejection was due
  // solely to a strippable extra property, does a second pass let `'strip'`
  // apply — and even then only the winning candidate's strips are kept.
  const exactProbe = { suppressed: false };
  for (const candidate of schema.schemas) {
    if (succeeds(candidate, value, context, path, state, exactProbe)) {
      return;
    }
  }
  if (exactProbe.suppressed) {
    // More than one candidate may tolerate stripping the value down to fit.
    // Picking the first in declaration order can silently destroy a key a
    // later, more specific candidate actually declares and needs, just
    // because it happened to be tried first. Instead, probe every candidate
    // without committing any strips, then keep only the one that needs to
    // strip the fewest properties — the least destructive fit — and merge
    // only that winner's strips into the real state.
    let winner: ValidationState | undefined;
    for (const candidate of schema.schemas) {
      const candidateState = probeCandidate(candidate, value, context, path, state, state.strictExtras);
      if (
        candidateState !== undefined &&
        (winner === undefined || candidateState.pendingStrips.length < winner.pendingStrips.length)
      ) {
        winner = candidateState;
      }
    }
    if (winner !== undefined) {
      if (state.protectionPlan !== undefined && winner.protectionPlan !== undefined) {
        state.protectionPlan.push(...winner.protectionPlan);
      }
      state.pendingStrips.push(...winner.pendingStrips);
      return;
    }
  }

  if (state.collector !== undefined) {
    const soleMatch = selectSoleStructuralMatch(schema, value, state);
    if (soleMatch !== undefined) {
      validate(soleMatch, value, context, path, state);
      return;
    }
  }

  report(state, context, path, 'union', value, 'TYPE_MISMATCH');
}

/**
 * In collecting mode only, and only once the `succeeds()` probe loop above
 * has already rejected every candidate (so this never overrides a value that
 * legitimately matches one of them): a failing union member can itself
 * contain many nested violations (an optional/nullable nested DTO), but the
 * probe above only ever reports one opaque pass/fail per candidate, in an
 * isolated fail-fast clone — so a nested DTO's own violations never reach
 * the collected list. This looks at the value's actual JS shape (an array,
 * or any other non-null object) and returns the single union member whose
 * resolved kind matches it, so that member's own validation — which may
 * report many violations, at any depth — runs directly against the live
 * collecting state, for a richer diagnostic on a genuine mismatch. Returns
 * undefined (falling back to the plain "union" report) for a
 * primitive/null/undefined value, or when more than one member's resolved
 * kind matches (a genuinely ambiguous union) — this is deliberately narrow:
 * it only resolves the common "exactly one object/array-shaped candidate"
 * case, not every possible union shape.
 */
function selectSoleStructuralMatch(
  schema: UnionSchema,
  value: unknown,
  state: ValidationState,
): Schema | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  const kind: 'array' | 'object' = Array.isArray(value) ? 'array' : 'object';
  const matches = schema.schemas
    .map((member) => (member.kind === 'ref' ? resolveReference(member, state.registry) : member))
    .filter((resolved) => resolved.kind === kind);
  return matches.length === 1 ? matches[0] : undefined;
}

function validateIntersection(
  schema: IntersectionSchema,
  value: unknown,
  context: AssertionContext,
  path: string,
  state: ValidationState,
): void {
  const objectSchemas = schema.schemas.filter(isObjectSchema);

  if (objectSchemas.length === schema.schemas.length) {
    validateObject(combineObjectSchemas(objectSchemas), value, context, path, state);
    return;
  }

  if (!isReferenceValue(value)) {
    // Branded/tagged primitives (`string & { readonly __brand: 'Id' }`) are a
    // type-level trick: the object member has no runtime representation on a
    // primitive, so it is a phantom marker and must not be enforced against
    // the value. The primitive members still are.
    for (const candidate of schema.schemas) {
      const resolved =
        candidate.kind === 'ref' ? resolveReference(candidate, state.registry) : candidate;
      if (!isObjectSchema(resolved)) {
        validate(candidate, value, context, path, state);
      }
    }
    return;
  }

  for (const candidate of schema.schemas) {
    validate(candidate, value, context, path, state);
  }
}

function validateArray(
  schema: ArraySchema,
  value: unknown,
  context: AssertionContext,
  path: string,
  state: ValidationState,
): void {
  if (!Array.isArray(value)) {
    report(state, context, path, 'array', value, 'TYPE_MISMATCH');
    return;
  }

  const itemContext = stripNestedTypeErrorResponse(context);
  for (let index = 0; index < value.length; index += 1) {
    validate(schema.items, value[index], itemContext, `${path}[${index}]`, state);
  }

  validateArrayOwnProperties(value, context, path, state);
}

function validateTuple(
  schema: TupleSchema,
  value: unknown,
  context: AssertionContext,
  path: string,
  state: ValidationState,
): void {
  if (!Array.isArray(value)) {
    report(state, context, path, 'tuple', value, 'TYPE_MISMATCH');
    return;
  }

  if (schema.rest === undefined || schema.rest === false) {
    if (value.length !== schema.items.length) {
      report(state, context, path, `tuple(${schema.items.length})`, value, 'TYPE_MISMATCH');
      return;
    }
  } else if (value.length < schema.items.length) {
    report(state, context, path, 'tuple', value, 'TYPE_MISMATCH');
    return;
  }

  const itemContext = stripNestedTypeErrorResponse(context);
  for (let index = 0; index < schema.items.length; index += 1) {
    validate(schema.items[index], value[index], itemContext, `${path}[${index}]`, state);
  }

  if (schema.rest !== undefined && schema.rest !== false) {
    for (let index = schema.items.length; index < value.length; index += 1) {
      validate(schema.rest, value[index], itemContext, `${path}[${index}]`, state);
    }
  }

  validateArrayOwnProperties(value, context, path, state);
}

/**
 * Map entries are addressed by their iteration index: `<path><i>.key` and
 * `<path><i>.value`. Array-style `[i]` is reserved for arrays and sets.
 */
function validateMap(
  schema: MapSchema,
  value: unknown,
  context: AssertionContext,
  path: string,
  state: ValidationState,
): void {
  if (!(value instanceof Map)) {
    report(state, context, path, 'Map', value, 'TYPE_MISMATCH');
    return;
  }

  const entryContext = stripNestedTypeErrorResponse(context);
  let index = 0;
  for (const [key, entryValue] of value) {
    validate(schema.key, key, entryContext, `${path}<${index}>.key`, state);
    validate(schema.value, entryValue, entryContext, `${path}<${index}>.value`, state);
    index += 1;
  }
}

function validateSet(
  schema: SetSchema,
  value: unknown,
  context: AssertionContext,
  path: string,
  state: ValidationState,
): void {
  if (!(value instanceof Set)) {
    report(state, context, path, 'Set', value, 'TYPE_MISMATCH');
    return;
  }

  const itemContext = stripNestedTypeErrorResponse(context);
  let index = 0;
  for (const item of value) {
    validate(schema.item, item, itemContext, `${path}[${index}]`, state);
    index += 1;
  }
}

function validateObject(
  schema: ObjectSchema,
  value: unknown,
  context: AssertionContext,
  path: string,
  state: ValidationState,
): void {
  if (schema.valueObjectCtor !== undefined) {
    // A ValueObject schema never validates structurally: the only accepted
    // value is an already-constructed instance. Raw strings are turned into
    // instances at the boundary (see autoConstructValueObject in guards.ts),
    // so reaching this point with a raw value means no boundary converted it.
    if (!(value instanceof schema.valueObjectCtor)) {
      report(state, context, path, valueObjectName(schema.valueObjectCtor), value, 'TYPE_MISMATCH');
    }
    return;
  }

  if (!isReferenceValue(value) || Array.isArray(value)) {
    report(state, context, path, 'object', value, 'TYPE_MISMATCH');
    return;
  }

  if (schema.instanceOf !== undefined && shouldEnforceInstanceOf(schema)) {
    if (!(value instanceof schema.instanceOf)) {
      report(state, context, path, instanceOfName(schema.instanceOf), value, 'TYPE_MISMATCH');
      return;
    }
  }

  const metadata = state.metadataCache.getObjectMetadata(schema);
  const declaredKeys = metadata.declaredKeys;
  // `context` was prepared (TypeErrorResponse/ExtraProperties/
  // isServerPopulated baked in) relative to whichever object started this
  // `protectValue` call, which is only ever the TOP-level value. A nested
  // class instance reached while walking the structure (a DTO field holding
  // another decorated class, an array of entities, …) has its own decorator
  // metadata that this recursive walk never consulted before reaching here —
  // only the later protection-install pass in guards.ts did, which runs AFTER
  // validation already succeeded or failed. Resolving it again for the
  // actual nested owner keeps a violation several levels deep from being
  // misclassified (a corrupted ServerPopulated() entity nested inside a
  // plain DTO reporting as a 400, or a decorated field's TypeErrorResponse
  // never being consulted on first contact with invalid input).
  const ownerContext = withOwnerClassExtraPropertiesPolicy(
    isServerPopulated(value) ? { ...context, isServerPopulated: true } : context,
    value,
  );

  for (const key of declaredKeys) {
    const property = schema.properties[key];
    const propertyPath = appendPropertyPath(path, key);

    if (!Reflect.has(value, key)) {
      if (property.optional !== true) {
        report(state, ownerContext, propertyPath, 'required property', value, 'REQUIRED_PROPERTY');
      }
      continue;
    }

    const propertyValue = Reflect.get(value, key);
    if (property.deferredAssignment === true && propertyValue === undefined) {
      continue;
    }
    const propertyContext = withNestedTypeErrorResponse(ownerContext, value, key);
    validate(property.schema, propertyValue, propertyContext, propertyPath, state);
  }

  for (const key of Reflect.ownKeys(value)) {
    if (metadata.declaredKeySet.has(key)) {
      continue;
    }

    const propertyPath = appendPropertyPath(path, key);
    if (schema.index !== undefined) {
      validate(schema.index, Reflect.get(value, key), ownerContext, propertyPath, state);
      continue;
    }

    if (schema.allowExtraProperties === true) {
      continue;
    }

    // Precedence: property-level decorator on the field holding this value
    // (baked into `schema.extraPropertiesPolicy` by guards.ts) > class-level
    // decorator on this value's own class, else on the nearest enclosing
    // decorated owner (both carried by `ownerContext.extraProperties`, see
    // withOwnerClassExtraPropertiesPolicy) > the global config default
    // (`context.extraProperties`, baked in by codegen) > 'error'.
    const policy = schema.extraPropertiesPolicy ?? ownerContext.extraProperties ?? 'error';
    if (policy === 'strip' && scheduleStrip(state, value, key, ownerContext, propertyPath)) {
      continue;
    }
    report(state, ownerContext, propertyPath, 'no extra properties', value, 'EXTRA_PROPERTY');
  }
}

/**
 * Per-property TypeErrorResponse, resolved against the actual nested owner
 * reached during the structural walk — mirrors `withTypeErrorResponse` in
 * guards.ts (same strip-then-reapply rule: a decorated parent never
 * customizes its nested children's own violations), kept local here because
 * guards.ts already imports from this module and importing back would be
 * circular.
 */
function withNestedTypeErrorResponse(
  context: AssertionContext,
  owner: object,
  key: PropertyKey,
): AssertionContext {
  const { typeErrorResponseMessage: _inheritedMessage, typeErrorResponseStatus: _inheritedStatus, ...inherited } = context;
  const response = getTypeErrorResponse(owner, typeof key === 'number' ? String(key) : key);
  if (response === undefined) {
    return inherited;
  }
  return {
    ...inherited,
    typeErrorResponseMessage: response.message,
    ...(response.status === undefined ? {} : { typeErrorResponseStatus: response.status }),
  };
}

/**
 * Array/tuple items and Map/Set entries have no property key of their own to
 * carry a `TypeErrorResponse`, so a decorated collection field's own response
 * must not leak onto violations found inside its elements — same
 * strip-without-reapplying half of {@link withNestedTypeErrorResponse}.
 */
function stripNestedTypeErrorResponse(context: AssertionContext): AssertionContext {
  const { typeErrorResponseMessage: _inheritedMessage, typeErrorResponseStatus: _inheritedStatus, ...inherited } = context;
  return inherited;
}

function validateArrayOwnProperties(
  value: readonly unknown[],
  context: AssertionContext,
  path: string,
  state: ValidationState,
): void {
  const policy = context.extraProperties ?? 'error';

  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length' || (typeof key === 'string' && isArrayIndex(key))) {
      continue;
    }

    const propertyPath = appendPropertyPath(path, key);
    if (policy === 'strip' && scheduleStrip(state, value, key, context, propertyPath)) {
      continue;
    }

    report(state, context, propertyPath, 'no extra properties', value, 'EXTRA_PROPERTY');
  }
}

/**
 * A class-level `ExtraProperties(policy)` on `owner` (or on any class in its
 * prototype chain) becomes the default policy for `owner` itself and for
 * everything validated beneath it, until a nested decorated class or a
 * property-level decorator overrides it again. Undecorated owners leave the
 * inherited default (ultimately the global config value) untouched.
 */
export function withOwnerClassExtraPropertiesPolicy(
  context: AssertionContext,
  owner: object,
): AssertionContext {
  const classPolicy = getExtraPropertiesPolicy(owner);
  if (classPolicy === undefined || classPolicy === context.extraProperties) {
    return context;
  }
  return { ...context, extraProperties: classPolicy };
}

/**
 * Records `key` for deletion once the whole assertion succeeds. Returns
 * `false` (the caller then reports `EXTRA_PROPERTY`) when the property could
 * never be deleted — a non-configurable own property on a sealed/frozen
 * object — so `'strip'` never silently degrades into "allow and keep", and
 * also while a union is probing for an exact (policy-independent) match.
 */
function scheduleStrip(
  state: ValidationState,
  target: object,
  key: PropertyKey,
  context: AssertionContext,
  path: string,
): boolean {
  if (state.strictExtras !== undefined) {
    state.strictExtras.suppressed = true;
    return false;
  }
  if (Reflect.getOwnPropertyDescriptor(target, key)?.configurable !== true) {
    return false;
  }
  state.pendingStrips.push({ target, key, context, path });
  return true;
}

function commitPendingStrips(state: ValidationState): void {
  const pending = state.pendingStrips.splice(0, state.pendingStrips.length);
  for (const strip of pending) {
    if (!Reflect.deleteProperty(strip.target, strip.key)) {
      report(state, strip.context, strip.path, 'no extra properties', strip.target, 'EXTRA_PROPERTY');
    }
  }
}

function combineObjectSchemas(schemas: readonly ObjectSchema[]): ObjectSchema {
  const propertiesByKey = new Map<PropertyKey, ObjectPropertySchema>();
  const indexSchemas: Schema[] = [];

  for (const schema of schemas) {
    for (const key of Reflect.ownKeys(schema.properties)) {
      const property = schema.properties[key];
      const existing = propertiesByKey.get(key);

      if (existing === undefined) {
        propertiesByKey.set(key, property);
        continue;
      }

      propertiesByKey.set(key, {
        schema: {
          kind: 'intersection',
          schemas: [existing.schema, property.schema],
        },
        ...(existing.optional === true && property.optional === true
          ? { optional: true }
          : {}),
      });
    }

    if (schema.index !== undefined) {
      indexSchemas.push(schema.index);
    }
  }

  return {
    kind: 'object',
    properties: Object.fromEntries(propertiesByKey),
    ...(schemas.length > 0 && schemas.every((schema) => schema.allowExtraProperties === true)
      ? { allowExtraProperties: true }
      : {}),
    ...(indexSchemas.length === 1
      ? { index: indexSchemas[0] }
      : indexSchemas.length > 1
        ? { index: { kind: 'intersection', schemas: indexSchemas } }
        : {}),
  };
}

function resolveReference(schema: RefSchema, registry: SchemaRegistry): Schema {
  const referencePath: string[] = [];
  const visitedNames = new Set<string>();
  let current: Schema = schema;

  while (current.kind === 'ref') {
    if (visitedNames.has(current.name)) {
      referencePath.push(current.name);
      throw new Error(
        `SchemaRegistry reference cycle has no concrete schema: ${referencePath.join(' -> ')}`,
      );
    }

    visitedNames.add(current.name);
    referencePath.push(current.name);
    const target = registry.get(current.name);

    if (target === undefined) {
      throw new Error(`SchemaRegistry has no schema named "${current.name}"`);
    }

    current = target;
  }

  return current;
}

function succeeds(
  schema: Schema,
  value: unknown,
  context: AssertionContext,
  path: string,
  state: ValidationState,
  strictExtras: ValidationState['strictExtras'] = state.strictExtras,
): boolean {
  const candidateState = cloneState(state, strictExtras);
  try {
    validate(schema, value, context, path, candidateState);
    if (state.protectionPlan !== undefined && candidateState.protectionPlan !== undefined) {
      state.protectionPlan.push(...candidateState.protectionPlan);
    }
    state.pendingStrips.push(...candidateState.pendingStrips);
    return true;
  } catch (error: unknown) {
    if (error instanceof StrictTypeError) {
      return false;
    }
    throw error;
  }
}

/**
 * Like {@link succeeds}, but never merges the candidate's strips/protection
 * plan into the real state — the caller decides which candidate (if any)
 * actually wins before merging anything. Returns the candidate's own clone
 * state on success (so the caller can inspect `pendingStrips.length`), or
 * `undefined` on a `StrictTypeError` mismatch.
 */
function probeCandidate(
  schema: Schema,
  value: unknown,
  context: AssertionContext,
  path: string,
  state: ValidationState,
  strictExtras: ValidationState['strictExtras'],
): ValidationState | undefined {
  const candidateState = cloneState(state, strictExtras);
  try {
    validate(schema, value, context, path, candidateState);
    return candidateState;
  } catch (error: unknown) {
    if (error instanceof StrictTypeError) {
      return undefined;
    }
    throw error;
  }
}

function cloneState(
  state: ValidationState,
  strictExtras: ValidationState['strictExtras'],
): ValidationState {
  const visited = new Map<object, Set<Schema>>();

  for (const [value, schemas] of state.visited) {
    visited.set(value, new Set<Schema>(schemas));
  }

  return {
    registry: state.registry,
    visited,
    metadataCache: state.metadataCache,
    protectionPlan: state.protectionPlan === undefined ? undefined : [],
    pendingStrips: [],
    ...(strictExtras === undefined ? {} : { strictExtras }),
  };
}

function wasVisited(
  value: object,
  schema: Schema,
  visited: Map<object, Set<Schema>>,
): boolean {
  const schemas = visited.get(value) ?? new Set<Schema>();

  if (schemas.has(schema)) {
    return true;
  }

  schemas.add(schema);
  visited.set(value, schemas);
  return false;
}

function isObjectSchema(schema: Schema): schema is ObjectSchema {
  return schema.kind === 'object';
}

function shouldEnforceInstanceOf(schema: ObjectSchema): boolean {
  if (schema.instanceOf === undefined) {
    return false;
  }
  const override = getClassValidationMode(schema.instanceOf);
  return override === undefined ? schema.strictClassDefault === true : override === 'strict';
}

function instanceOfName(constructor: Function): string {
  return constructor.name.length > 0 ? constructor.name : 'class instance';
}

function valueObjectName(constructor: Function): string {
  return constructor.name.length > 0 ? constructor.name : 'ValueObject';
}

function isArrayIndex(key: string): boolean {
  const index = Number(key);
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index <= MAX_ARRAY_INDEX &&
    String(index) === key
  );
}

function matchesPrimitive(name: PrimitiveName, value: unknown): boolean {
  if (name === 'null') {
    return value === null;
  }
  if (name === 'object') {
    return typeof value === 'object' && value !== null;
  }
  return typeof value === name;
}

function appendPropertyPath(path: string, key: PropertyKey): string {
  return typeof key === 'symbol' ? `${path}[${String(key)}]` : `${path}.${key}`;
}

function literalName(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function isReferenceValue(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function traversesReferenceValue(schema: Schema): boolean {
  switch (schema.kind) {
    case 'array':
    case 'intersection':
    case 'map':
    case 'object':
    case 'set':
    case 'tuple':
    case 'union':
      return true;
    default:
      return false;
  }
}

function receivedName(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

const templateLiteralPatterns = new Map<string, RegExp>();

function matchesTemplateLiteral(pattern: string, value: string): boolean {
  let regex = templateLiteralPatterns.get(pattern);
  if (regex === undefined) {
    regex = new RegExp(pattern);
    templateLiteralPatterns.set(pattern, regex);
  }
  return regex.test(value);
}

function report(
  state: ValidationState,
  context: AssertionContext,
  path: string,
  expected: string,
  value: unknown,
  code: StrictTypeErrorInfo['code'],
): void {
  const info: StrictTypeErrorInfo = {
    code,
    ...(context.className === undefined ? {} : { className: context.className }),
    ...(context.functionName === undefined ? {} : { functionName: context.functionName }),
    ...(context.isServerPopulated === true ? { isServerPopulated: true } : {}),
    ...(context.typeErrorResponseMessage === undefined
      ? {}
      : { typeErrorResponseMessage: context.typeErrorResponseMessage }),
    ...(context.typeErrorResponseStatus === undefined
      ? {}
      : { typeErrorResponseStatus: context.typeErrorResponseStatus }),
    contractKind: context.contractKind,
    propertyPath: path,
    expected,
    received: receivedName(value),
    operation: context.operation,
  };

  if (state.collector !== undefined) {
    state.collector.push(info);
    return;
  }

  throw new StrictTypeError(info);
}
