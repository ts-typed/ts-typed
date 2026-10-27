import { isAggregateErrorsEnabled } from '../aggregate-errors.decorator';
import { AggregateStrictTypeError } from '../aggregate-strict-type-error.class';
import { ArrayAggregateStrictTypeError } from '../array-aggregate-strict-type-error.class';
import { getExtraPropertiesPolicy } from '../extra-properties.decorator';
import { isServerPopulated } from '../server-populated.decorator';
import {
  getTypeErrorResponse,
  type TypeErrorResponseOptions,
} from '../type-error-response.decorator';
import {
  assertValue,
  assertValueCollecting,
  assertValueCollectingDeferred,
  assertValueWithSession,
  withOwnerClassExtraPropertiesPolicy,
} from '../assert-value';
import { collectIfAggregating, isAggregating, takeAggregateWindowViolations } from '../aggregate-window';
import type { AssertionContext } from '../assertion-context.interface';
import type { StrictTypeErrorInfo } from '../strict-type-error-info.interface';
import type {
  ArraySchema,
  MapSchema,
  ObjectPropertySchema,
  ObjectSchema,
  SchemaProperties,
  SetSchema,
  TupleSchema,
} from '../schema.interface';
import type { Schema } from '../schema.type';
import { StrictTypeError } from '../strict-type-error.class';
import {
  SchemaMetadataCache,
  type ObjectProtectionInstaller,
} from '../schema-metadata-cache.class';
import { createTraversalSession } from '../traversal-session';
import type { ProtectionPlanEntry } from '../traversal-session';
import type { ValueObjectErrorContext } from '../value-object.class';
import type { FieldGuardOptions } from './field-guard-options.interface';

interface GuardContract {
  readonly schema: Schema;
  readonly context: AssertionContext;
  readonly extraPropertiesPolicy?: 'error' | 'strip';
}

interface DataPropertyGuardState {
  readonly contracts: GuardContract[];
  value: unknown;
  isInitialized: boolean;
  isReadonlyField: boolean;
  isLocked: boolean;
}

interface SharedDataAccessors {
  readonly get: (this: object) => unknown;
  readonly set: (this: object, value: unknown) => void;
}

interface ProtectionState {
  readonly visited: Map<object, Set<Schema>>;
  readonly metadataCache: SchemaMetadataCache;
}

interface ValueObjectMaterializationState {
  readonly visited: Map<object, Set<Schema>>;
  readonly materializableSchemas: Map<Schema, boolean>;
  readonly resolvingSchemas: Set<Schema>;
}

interface PreparedContract {
  readonly schema: Schema;
  readonly context: AssertionContext;
}

const installedDataGuards = new WeakMap<
  object,
  Map<PropertyKey, DataPropertyGuardState>
>();
const sharedDataAccessors = new Map<PropertyKey, SharedDataAccessors>();
const mutationProxyTargets = new WeakMap<object, object>();

function guardOwnerOf(value: object, key: PropertyKey): object | undefined {
  let candidate: object | null = mutationProxyTargets.get(value) ?? value;
  while (candidate !== null) {
    if (installedDataGuards.get(candidate)?.has(key) === true) {
      return candidate;
    }
    candidate = Object.getPrototypeOf(candidate) as object | null;
  }
  return undefined;
}

function getSharedDataAccessors(key: PropertyKey): SharedDataAccessors {
  const existing = sharedDataAccessors.get(key);
  if (existing !== undefined) {
    return existing;
  }

  const accessors: SharedDataAccessors = {
    get(this: object): unknown {
      const owner = guardOwnerOf(this, key);
      return owner === undefined ? undefined : installedDataGuards.get(owner)?.get(key)?.value;
    },
    set(this: object, nextValue: unknown): void {
      const owner = guardOwnerOf(this, key);
      const guard = owner === undefined ? undefined : installedDataGuards.get(owner)?.get(key);
      if (guard !== undefined && owner !== undefined) {
        setGuardedValue(guard, nextValue, owner);
      }
    },
  };
  sharedDataAccessors.set(key, accessors);
  return accessors;
}

/**
 * Mutation-guard proxies already created for an underlying array, so the same
 * array crossing the same typed boundary twice yields the same proxy.
 */
interface MutationGuardEntry {
  readonly schema: Schema;
  readonly context: AssertionContext;
  readonly proxy: unknown[];
}

const mutationGuardEntries = new WeakMap<object, MutationGuardEntry[]>();
const mutationGuardProxies = new WeakSet<object>();

export function protectValue(
  schema: Schema,
  value: unknown,
  context: AssertionContext,
): unknown {
  const contract: GuardContract = {
    schema,
    context,
    extraPropertiesPolicy: undefined,
  };
  const prepared = prepareContract(contract, value, context.operation);
  const materializationState = createValueObjectMaterializationState();
  const materializedValue = schemaCanMaterializeValueObject(
    prepared.schema,
    prepared.context,
    materializationState,
  )
    ? materializeValueObjects(prepared.schema, value, prepared.context, materializationState)
    : value;
  const session = createTraversalSession(prepared.context);

  const valueObjectCtor = valueObjectCtorOf(prepared.schema, prepared.context);
  if (valueObjectCtor !== undefined) {
    return autoConstructValueObject(valueObjectCtor, materializedValue, prepared.context);
  }

  const resolvedForAggregation = resolveReference(prepared.schema, prepared.context);
  const schemaRequestsAggregation =
    (resolvedForAggregation.kind === 'object' && resolvedForAggregation.aggregateErrors === true) ||
    // The parameter's own declared type can itself be a union (`Dto |
    // undefined`, `Dto | null`), not just a nested field being optional — in
    // that case the resolved schema is a UnionSchema, not directly an
    // ObjectSchema, so the check above alone would miss it. Request
    // aggregation when exactly one member (after resolving refs) is an
    // aggregateErrors object schema. Two or more such members in the same
    // union is a genuinely ambiguous case (which member's violations would
    // even apply?); this deliberately does not guess, and instead falls back
    // to the ordinary `isAggregateErrorsEnabled(value)` runtime check below
    // (which itself typically resolves to fail-fast for a plain object
    // literal, since there is no runtime-constructed instance to carry that
    // marker) rather than silently aggregating against the wrong member or
    // double-counting across members.
    (resolvedForAggregation.kind === 'union' &&
      resolvedForAggregation.schemas
        .map((member) => resolveReference(member, prepared.context))
        .filter((member) => member.kind === 'object' && member.aggregateErrors === true).length === 1);

  // Mirrors schemaRequestsAggregation above, but resolved against an array's
  // item schema instead of the parameter's own schema: detects `dtos:
  // CreateUserDto[]` the same way the single-object branch detects `dto:
  // CreateUserDto`. Deliberately does not fall back to a runtime
  // isAggregateErrorsEnabled(element) check: without a declared item schema
  // there is no up-front decision for every element, so an undeclared or
  // ambiguous item type stays fail-fast, same as today.
  const arrayItemSchema = resolvedForAggregation.kind === 'array' ? resolvedForAggregation.items : undefined;
  const resolvedItemForAggregation =
    arrayItemSchema === undefined ? undefined : resolveReference(arrayItemSchema, prepared.context);
  const arrayItemRequestsAggregation =
    resolvedItemForAggregation !== undefined &&
    ((resolvedItemForAggregation.kind === 'object' && resolvedItemForAggregation.aggregateErrors === true) ||
      (resolvedItemForAggregation.kind === 'union' &&
        resolvedItemForAggregation.schemas
          .map((member) => resolveReference(member, prepared.context))
          .filter((member) => member.kind === 'object' && member.aggregateErrors === true).length === 1));

  if (
    prepared.context.contractKind === 'parameter' &&
    isReferenceValue(materializedValue) &&
    !Array.isArray(materializedValue) &&
    (schemaRequestsAggregation || isAggregateErrorsEnabled(materializedValue))
  ) {
    const windowViolations = takeAggregateWindowViolations(materializedValue) ?? [];
    const { violations: structuralViolations, commit } = assertValueCollectingDeferred(
      prepared.schema,
      materializedValue,
      prepared.context,
      session,
    );
    const violations = [...windowViolations, ...structuralViolations];
    if (violations.length > 0) {
      throw new AggregateStrictTypeError(violations);
    }
    commit();
  } else if (
    prepared.context.contractKind === 'parameter' &&
    Array.isArray(materializedValue) &&
    arrayItemSchema !== undefined &&
    arrayItemRequestsAggregation
  ) {
    const elementErrors: AggregateStrictTypeError[] = [];
    const commits: Array<() => void> = [];
    for (let index = 0; index < materializedValue.length; index += 1) {
      const element = materializedValue[index];
      const elementContext = indexedContext(prepared.context, index);
      const windowViolations = isReferenceValue(element)
        ? (takeAggregateWindowViolations(element) ?? []).map((violation) =>
            reindexWindowViolation(violation, elementContext),
          )
        : [];
      const { violations: structuralViolations, commit } = assertValueCollectingDeferred(
        arrayItemSchema,
        element,
        elementContext,
        session,
      );
      const violations = [...windowViolations, ...structuralViolations];
      if (violations.length > 0) {
        elementErrors.push(new AggregateStrictTypeError(violations, index));
      } else {
        commits.push(commit);
      }
    }
    if (elementErrors.length > 0) {
      throw new ArrayAggregateStrictTypeError(elementErrors);
    }
    for (const commit of commits) {
      commit();
    }
  } else {
    assertValueWithSession(prepared.schema, materializedValue, prepared.context, session);
  }
  installProtectionFromPlan(session.protectionPlan, session.metadataCache);
  if (context.enforceMutationGuards === true) {
    if (Array.isArray(materializedValue)) {
      return guardArrayMutations(prepared.schema, materializedValue, prepared.context);
    }
    if (materializedValue instanceof Map) {
      return guardMapMutations(prepared.schema, materializedValue, prepared.context);
    }
    if (materializedValue instanceof Set) {
      return guardSetMutations(prepared.schema, materializedValue, prepared.context);
    }
    if (typeof materializedValue === 'object' && materializedValue !== null) {
      return guardObjectMutations(prepared.schema, materializedValue, prepared.context);
    }
  }
  return materializedValue;
}

/**
 * Returns the `ValueObject` constructor when `schema` (after resolving refs)
 * is an object schema marked with `valueObjectCtor`, otherwise `undefined`.
 */
function valueObjectCtorOf(schema: Schema, context: AssertionContext): Function | undefined {
  const resolved = resolveReference(schema, context);
  return resolved.kind === 'object' ? resolved.valueObjectCtor : undefined;
}

/**
 * Shared auto-construct step for a boundary crossing a `ValueObject` schema.
 * Used by both {@link protectValue} and the field setter built in
 * {@link installDataGuard}, so the behavior cannot drift between them.
 *
 * - An existing instance of `ctor` is returned unchanged (no re-validation,
 *   no re-construction).
 * - A raw string is passed to `new ctor(raw, valueObjectContext)`. The class's
 *   own constructor runs `isValid` and throws `StrictTypeError` on failure;
 *   that error is deliberately not caught or rewrapped here.
 * - Any other value is rejected as a `TYPE_MISMATCH` (via `assertValue`, so the
 *   error has the same shape as every other mismatch).
 *
 * The returned value is what the caller must store or hand out in place of the
 * original raw value.
 */
export function autoConstructValueObject(
  ctor: Function,
  value: unknown,
  context: AssertionContext,
): unknown {
  if (value instanceof ctor) {
    return value;
  }
  if (typeof value !== 'string') {
    assertValue({ kind: 'object', properties: {}, valueObjectCtor: ctor }, value, context);
  }

  const valueObjectContext: ValueObjectErrorContext = {
    propertyPath: context.propertyPath,
    contractKind: context.contractKind,
    operation: context.operation,
    ...(context.className === undefined ? {} : { className: context.className }),
  };
  const Constructor = ctor as new (raw: string, context?: ValueObjectErrorContext) => object;
  return new Constructor(value as string, valueObjectContext);
}

/**
 * Replaces raw strings with their ValueObject instances inside a structured
 * value before its schema is asserted. A function parameter remains the same
 * object reference, so code after the compiler-inserted boundary guard sees
 * the materialized instance at its declared property.
 */
function materializeValueObjects(
  schema: Schema,
  value: unknown,
  context: AssertionContext,
  state: ValueObjectMaterializationState,
): unknown {
  const resolved = resolveReference(schema, context);
  const valueObjectCtor = resolved.kind === 'object' ? resolved.valueObjectCtor : undefined;
  if (valueObjectCtor !== undefined) {
    return autoConstructValueObject(valueObjectCtor, value, context);
  }

  if (!schemaCanMaterializeValueObject(resolved, context, state)) {
    return value;
  }

  switch (resolved.kind) {
    case 'object':
      materializeObjectValueObjects(resolved, value, context, state);
      return value;
    case 'array':
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
          const item = value[index];
          const materializedItem = materializeValueObjects(
            resolved.items,
            item,
            { ...context, propertyPath: `${context.propertyPath}[${index}]` },
            state,
          );
          if (materializedItem !== item) {
            Reflect.set(value, index, materializedItem);
          }
        }
      }
      return value;
    case 'tuple':
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
          const itemSchema = index < resolved.items.length
            ? resolved.items[index]
            : resolved.rest === false || resolved.rest === undefined
              ? undefined
              : resolved.rest;
          if (itemSchema === undefined) {
            continue;
          }
          const item = value[index];
          const materializedItem = materializeValueObjects(
            itemSchema,
            item,
            { ...context, propertyPath: `${context.propertyPath}[${index}]` },
            state,
          );
          if (materializedItem !== item) {
            Reflect.set(value, index, materializedItem);
          }
        }
      }
      return value;
    case 'intersection':
      for (const member of resolved.schemas) {
        materializeValueObjects(member, value, context, state);
      }
      return value;
    case 'ref':
    case 'union':
    case 'map':
    case 'set':
    case 'literal':
    case 'never':
    case 'primitive':
    case 'date':
    case 'function':
    case 'templateLiteral':
    case 'unknown':
      return value;
  }
}

function materializeObjectValueObjects(
  schema: ObjectSchema,
  value: unknown,
  context: AssertionContext,
  state: ValueObjectMaterializationState,
): void {
  if (!isReferenceValue(value) || Array.isArray(value) || wasMaterialized(value, schema, state)) {
    return;
  }

  for (const key of Reflect.ownKeys(schema.properties)) {
    const property = schema.properties[key];
    if (!Reflect.has(value, key)) {
      continue;
    }
    const propertyValue = Reflect.get(value, key);
    if (property.deferredAssignment === true && propertyValue === undefined) {
      continue;
    }
    const materializedValue = materializeValueObjects(
      property.schema,
      propertyValue,
      nestedContext(context, key),
      state,
    );
    if (materializedValue !== propertyValue) {
      Reflect.set(value, key, materializedValue);
    }
  }

  if (schema.index === undefined) {
    return;
  }

  for (const key of Reflect.ownKeys(value)) {
    if (Object.hasOwn(schema.properties, key)) {
      continue;
    }
    const propertyValue = Reflect.get(value, key);
    const materializedValue = materializeValueObjects(
      schema.index,
      propertyValue,
      nestedContext(context, key),
      state,
    );
    if (materializedValue !== propertyValue) {
      Reflect.set(value, key, materializedValue);
    }
  }
}

function createValueObjectMaterializationState(): ValueObjectMaterializationState {
  return {
    visited: new Map<object, Set<Schema>>(),
    materializableSchemas: new Map<Schema, boolean>(),
    resolvingSchemas: new Set<Schema>(),
  };
}

function schemaCanMaterializeValueObject(
  schema: Schema,
  context: AssertionContext,
  state: ValueObjectMaterializationState,
): boolean {
  const cached = state.materializableSchemas.get(schema);
  if (cached !== undefined) {
    return cached;
  }
  if (state.resolvingSchemas.has(schema)) {
    return false;
  }

  state.resolvingSchemas.add(schema);
  const resolved = resolveReference(schema, context);
  const canMaterialize = resolved.kind === 'object'
    ? resolved.valueObjectCtor !== undefined ||
      Reflect.ownKeys(resolved.properties).some((key) =>
        schemaCanMaterializeValueObject(resolved.properties[key].schema, context, state),
      ) ||
      (resolved.index !== undefined && schemaCanMaterializeValueObject(resolved.index, context, state))
    : resolved.kind === 'array'
      ? schemaCanMaterializeValueObject(resolved.items, context, state)
      : resolved.kind === 'tuple'
        ? resolved.items.some((item) => schemaCanMaterializeValueObject(item, context, state)) ||
          (resolved.rest !== undefined &&
            resolved.rest !== false &&
            schemaCanMaterializeValueObject(resolved.rest, context, state))
        : resolved.kind === 'intersection'
          ? resolved.schemas.some((member) => schemaCanMaterializeValueObject(member, context, state))
          : false;
  state.resolvingSchemas.delete(schema);
  state.materializableSchemas.set(schema, canMaterialize);
  if (resolved !== schema) {
    state.materializableSchemas.set(resolved, canMaterialize);
  }
  return canMaterialize;
}

function wasMaterialized(
  value: object,
  schema: Schema,
  state: ValueObjectMaterializationState,
): boolean {
  const schemas = state.visited.get(value) ?? new Set<Schema>();
  if (schemas.has(schema)) {
    return true;
  }
  schemas.add(schema);
  state.visited.set(value, schemas);
  return false;
}

/**
 * Returns a Proxy over `array` whose element and `length` writes are checked
 * against the array's item schema, so a later `push('wrong')` or
 * `arr[5] = 'wrong'` throws a `StrictTypeError` instead of succeeding. Only
 * `set` and `deleteProperty` are trapped: deletions (including the ones
 * `length` truncation performs internally) are forwarded unchanged, and
 * `length` writes are not validated because they introduce no element.
 * Schemas that do not resolve to an array (tuples, maps, sets, objects) are
 * returned untouched.
 */
function guardArrayMutations(
  schema: Schema,
  array: unknown[],
  context: AssertionContext,
  session: MutationSession = createMutationSession(),
): unknown[] {
  if (mutationGuardProxies.has(array)) {
    return array;
  }
  const resolved = resolveReference(schema, context);
  if (resolved.kind !== 'array') {
    return array;
  }
  const inProgress = sessionProxy(session, array, resolved);
  if (inProgress !== undefined) {
    return inProgress as unknown[];
  }

  const entries = mutationGuardEntries.get(array) ?? [];
  const existing = entries.find(
    (entry) =>
      entry.schema === resolved &&
      entry.context.propertyPath === context.propertyPath &&
      entry.context.registry === context.registry,
  );
  if (existing !== undefined) {
    return existing.proxy;
  }

  const items = resolved.items;
  const proxy = new Proxy(array, {
    set(target, property: string | symbol, nextValue: unknown): boolean {
      if (isArrayIndexKey(property)) {
        const itemContext: AssertionContext = mutationEntryContext(context, `${context.propertyPath}[${property}]`);
        assertValue(items, nextValue, itemContext);
        installProtection(items, nextValue, itemContext, createProtectionState());
        const stored = wrapMutationValue(items, nextValue, itemContext);
        return Reflect.set(target, property, stored, target);
      }
      return Reflect.set(target, property, nextValue, target);
    },
    deleteProperty(target, property: string | symbol): boolean {
      return Reflect.deleteProperty(target, property);
    },
  });

  entries.push({ schema: resolved, context, proxy });
  mutationGuardEntries.set(array, entries);
  mutationGuardProxies.add(proxy);
  rememberSessionProxy(session, array, resolved, proxy);
  wrapNestedArrayItems(array, resolved, context, session);
  return proxy;
}

function isArrayIndexKey(property: string | symbol): property is string {
  return (
    typeof property === 'string' &&
    /^(0|[1-9]\d*)$/.test(property) &&
    Number(property) < 4_294_967_295
  );
}

/**
 * Proxies already created for an underlying Map or Set, keyed by the
 * collection and reused when the same collection crosses the same boundary
 * again. Kept apart from `mutationGuardEntries` so the array path is untouched.
 */
interface CollectionMutationGuardEntry {
  readonly schema: Schema;
  readonly context: AssertionContext;
  readonly proxy: object;
}

const collectionMutationEntries = new WeakMap<object, CollectionMutationGuardEntry[]>();

/**
 * Map/Set counterpart of `guardArrayMutations`. Both collections keep their
 * entries in an internal slot that only the genuine `Map.prototype` /
 * `Set.prototype` methods can read, so a Proxy must never be used as `this`
 * for them: every read is performed on the real target, and only `set`
 * (Map) and `add` (Set) are replaced with validating wrappers. `delete` and
 * `clear` remove entries and cannot introduce a type violation, so they are
 * forwarded unchanged. The wrappers return the proxy so chained calls such as
 * `map.set(a, 1).set(b, 2)` keep going through the guarded version.
 */
function guardMapMutations(
  schema: Schema,
  map: Map<unknown, unknown>,
  context: AssertionContext,
  session: MutationSession = createMutationSession(),
): Map<unknown, unknown> {
  if (mutationGuardProxies.has(map)) {
    return map;
  }
  const resolved = resolveReference(schema, context);
  if (resolved.kind !== 'map') {
    return map;
  }
  const inProgress = sessionProxy(session, map, resolved);
  if (inProgress !== undefined) {
    return inProgress as Map<unknown, unknown>;
  }
  const existing = findCollectionMutationProxy(map, resolved, context);
  if (existing !== undefined) {
    return existing as Map<unknown, unknown>;
  }

  const keySchema = resolved.key;
  const valueSchema = resolved.value;
  const proxy: Map<unknown, unknown> = new Proxy(map, {
    get(target, property: string | symbol): unknown {
      if (property === 'set') {
        return (key: unknown, entryValue: unknown): Map<unknown, unknown> => {
          const keyContext = mutationEntryContext(context, `${context.propertyPath}<mutate>.key`);
          assertValue(keySchema, key, keyContext);
          installProtection(keySchema, key, keyContext, createProtectionState());
          const valueContext = mutationEntryContext(context, `${context.propertyPath}<mutate>.value`);
          assertValue(valueSchema, entryValue, valueContext);
          installProtection(valueSchema, entryValue, valueContext, createProtectionState());
          target.set(key, wrapMutationValue(valueSchema, entryValue, valueContext));
          return proxy;
        };
      }
      if (property === 'delete') {
        return (key: unknown): boolean => target.delete(key);
      }
      if (property === 'clear') {
        return (): void => target.clear();
      }
      const member = Reflect.get(target, property, target);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });

  rememberCollectionMutationProxy(map, resolved, context, proxy);
  rememberSessionProxy(session, map, resolved, proxy);
  wrapNestedMapEntries(map, resolved, context, session);
  return proxy;
}

/**
 * Set counterpart of `guardMapMutations`: `add` validates the item before it
 * reaches the real set, and everything else is read from the real target.
 */
function guardSetMutations(
  schema: Schema,
  set: Set<unknown>,
  context: AssertionContext,
  session: MutationSession = createMutationSession(),
): Set<unknown> {
  if (mutationGuardProxies.has(set)) {
    return set;
  }
  const resolved = resolveReference(schema, context);
  if (resolved.kind !== 'set') {
    return set;
  }
  const inProgress = sessionProxy(session, set, resolved);
  if (inProgress !== undefined) {
    return inProgress as Set<unknown>;
  }
  const existing = findCollectionMutationProxy(set, resolved, context);
  if (existing !== undefined) {
    return existing as Set<unknown>;
  }

  const itemSchema = resolved.item;
  const proxy: Set<unknown> = new Proxy(set, {
    get(target, property: string | symbol): unknown {
      if (property === 'add') {
        return (item: unknown): Set<unknown> => {
          const itemContext = mutationEntryContext(context, `${context.propertyPath}<mutate>`);
          assertValue(itemSchema, item, itemContext);
          installProtection(itemSchema, item, itemContext, createProtectionState());
          target.add(wrapMutationValue(itemSchema, item, itemContext));
          return proxy;
        };
      }
      if (property === 'delete') {
        return (item: unknown): boolean => target.delete(item);
      }
      if (property === 'clear') {
        return (): void => target.clear();
      }
      const member = Reflect.get(target, property, target);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });

  rememberCollectionMutationProxy(set, resolved, context, proxy);
  rememberSessionProxy(session, set, resolved, proxy);
  wrapNestedSetItems(set, resolved, context, session);
  return proxy;
}

function mutationEntryContext(context: AssertionContext, propertyPath: string): AssertionContext {
  const { typeErrorResponseMessage: _inheritedMessage, typeErrorResponseStatus: _inheritedStatus, ...inherited } = context;
  return { ...inherited, propertyPath, operation: 'mutate' };
}

/**
 * Proxies created during one top-level wrap, keyed by the underlying value and
 * its resolved schema. A value reached again while its own wrap is still in
 * progress (a cycle, such as `node.self = node`) returns the proxy already
 * being built instead of recursing forever. The schema is part of the key so a
 * value reached at two different declared positions still gets the proxy for
 * each one. Every trap or nested wrap that needs one starts a fresh session.
 */
type MutationSession = Map<object, Map<Schema, object>>;

function createMutationSession(): MutationSession {
  return new Map();
}

function sessionProxy(session: MutationSession, value: object, schema: Schema): object | undefined {
  return session.get(value)?.get(schema);
}

function rememberSessionProxy(
  session: MutationSession,
  value: object,
  schema: Schema,
  proxy: object,
): void {
  const schemas = session.get(value) ?? new Map<Schema, object>();
  schemas.set(schema, proxy);
  session.set(value, schemas);
}

/**
 * Wraps `value` with the guard that matches its runtime shape and the declared
 * `schema`, recursively. A value that is not a reference, is already a guard
 * proxy, or does not match its schema's kind is returned as is. Used both when
 * a nested value is found already present (see the `wrapNested*` helpers) and
 * when a new value is written through a trap.
 */
function wrapMutationValue(
  schema: Schema,
  value: unknown,
  context: AssertionContext,
  session: MutationSession = createMutationSession(),
): unknown {
  if (!isReferenceValue(value) || mutationGuardProxies.has(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    const candidate = selectMutationSchema(schema, 'array', context);
    return candidate === undefined ? value : guardArrayMutations(candidate, value, context, session);
  }
  if (value instanceof Map) {
    const candidate = selectMutationSchema(schema, 'map', context);
    return candidate === undefined ? value : guardMapMutations(candidate, value, context, session);
  }
  if (value instanceof Set) {
    const candidate = selectMutationSchema(schema, 'set', context);
    return candidate === undefined ? value : guardSetMutations(candidate, value, context, session);
  }
  if (typeof value === 'object') {
    const candidate = selectMutationSchema(schema, 'object', context);
    return candidate === undefined ? value : guardObjectMutations(candidate, value, context, session);
  }
  return value;
}

/**
 * Finds the schema a runtime value of shape `kind` is checked against. An
 * optional property is declared as a union with `undefined`, so a union is
 * searched for its single member of that kind. A union with several members of
 * that kind is ambiguous and yields `undefined`, which leaves the value
 * unwrapped rather than guessing.
 */
function selectMutationSchema(
  schema: Schema,
  kind: 'array' | 'map' | 'set' | 'object',
  context: AssertionContext,
): Schema | undefined {
  const resolved = resolveReference(schema, context);
  if (resolved.kind === kind) {
    return resolved;
  }
  if (resolved.kind !== 'union') {
    return undefined;
  }
  const matches = resolved.schemas
    .map((member) => selectMutationSchema(member, kind, context))
    .filter((member): member is Schema => member !== undefined);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Wraps the array items present when the array's guard is created, writing each
 * wrapped item back onto the real array so later reads see the guarded version.
 */
function wrapNestedArrayItems(
  array: unknown[],
  schema: ArraySchema,
  context: AssertionContext,
  session: MutationSession,
): void {
  for (let index = 0; index < array.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
    if (descriptor === undefined || isAccessorDescriptor(descriptor)) {
      continue;
    }
    const current = descriptor.value as unknown;
    const wrapped = wrapMutationValue(schema.items, current, indexedContext(context, index), session);
    if (wrapped !== current) {
      Reflect.set(array, String(index), wrapped, array);
    }
  }
}

/**
 * Wraps the Map entries present when the Map's guard is created. Values are
 * replaced in place with `target.set`, which keeps the key and its position.
 * Keys keep their identity (replacing a key would break lookups by the original
 * reference), so a key that is itself a structure is only walked: its own nested
 * children are wrapped in place, the key object is not replaced.
 */
function wrapNestedMapEntries(
  map: Map<unknown, unknown>,
  schema: MapSchema,
  context: AssertionContext,
  session: MutationSession,
): void {
  const { typeErrorResponseMessage: _inheritedMessage, typeErrorResponseStatus: _inheritedStatus, ...entryContext } = context;
  let index = 0;
  for (const [key, entryValue] of [...map]) {
    const keyContext = { ...entryContext, propertyPath: `${context.propertyPath}<${index}>.key` };
    wrapMutationValue(schema.key, key, keyContext, session);
    const valueContext = { ...entryContext, propertyPath: `${context.propertyPath}<${index}>.value` };
    const wrapped = wrapMutationValue(schema.value, entryValue, valueContext, session);
    if (wrapped !== entryValue) {
      map.set(key, wrapped);
    }
    index += 1;
  }
}

/**
 * Set items present before the guard existed cannot be replaced without
 * removing and re-adding them, which would change iteration order, so they are
 * not swapped for their wrapped versions. Each item is only walked: any nested
 * array, Map, Set or object inside it is wrapped in place, but the item itself
 * stays unguarded. Items added later through `add` are wrapped as they are added.
 */
function wrapNestedSetItems(
  set: Set<unknown>,
  schema: SetSchema,
  context: AssertionContext,
  session: MutationSession,
): void {
  let index = 0;
  for (const item of [...set]) {
    wrapMutationValue(schema.item, item, indexedContext(context, index), session);
    index += 1;
  }
}

/**
 * Wraps the declared properties present on a plain object when its guard is
 * created. Reads go through `Reflect.get` because installed guards are
 * accessors; the write-back goes through {@link storeMutationValue}.
 */
function wrapNestedObjectProperties(
  target: object,
  properties: SchemaProperties,
  context: AssertionContext,
  session: MutationSession,
): void {
  for (const key of Reflect.ownKeys(properties)) {
    if (Object.getOwnPropertyDescriptor(target, key) === undefined) {
      continue;
    }
    const current = Reflect.get(target, key, target) as unknown;
    const wrapped = wrapMutationValue(
      properties[key].schema,
      current,
      nestedContext(context, key),
      session,
    );
    if (wrapped !== current) {
      storeMutationValue(target, key, wrapped);
    }
  }
}

/**
 * Replaces the stored value of an own property with `value` without running
 * the guard's validation again. The value being stored is a proxy over a value
 * that already passed validation, and an installed readonly guard would refuse
 * a setter call, so the installed guard's stored value is updated directly.
 */
function storeMutationValue(owner: object, key: PropertyKey, value: unknown): void {
  const guard = getInstalledGuard(owner, key);
  if (guard !== undefined) {
    guard.value = value;
    return;
  }
  Reflect.set(owner, key, value, owner);
}

function findCollectionMutationProxy(
  collection: object,
  schema: Schema,
  context: AssertionContext,
): object | undefined {
  return (collectionMutationEntries.get(collection) ?? []).find(
    (entry) =>
      entry.schema === schema &&
      entry.context.propertyPath === context.propertyPath &&
      entry.context.registry === context.registry,
  )?.proxy;
}

function rememberCollectionMutationProxy(
  collection: object,
  schema: Schema,
  context: AssertionContext,
  proxy: object,
): void {
  const entries = collectionMutationEntries.get(collection) ?? [];
  entries.push({ schema, context, proxy });
  collectionMutationEntries.set(collection, entries);
  mutationGuardProxies.add(proxy);
  mutationProxyTargets.set(proxy, collection);
}

/**
 * Plain-object counterpart of `guardArrayMutations`, for an object or interface
 * that crosses a typed boundary. The per-property accessors installed by
 * `installObjectProtection` cannot cover every write: on a sealed object the
 * properties are non-configurable, so the accessors are never installed and
 * the plain data properties stay writable; and a required key can be deleted
 * or redefined because the accessors are configurable. This Proxy closes
 * those paths with three traps:
 * - `set` validates a declared property's new value before the write;
 * - `deleteProperty` refuses to remove a required declared property;
 * - `defineProperty` refuses a declared property whose new `value` fails its schema.
 * A refusal returns `false` instead of throwing `StrictTypeError`, so the
 * engine itself produces the native error (a `delete` in strict code, or a
 * `TypeError` from `Object.defineProperty`), matching class instances.
 * Undeclared keys (extra properties and index signatures) are forwarded
 * untouched. Only objects whose prototype is `Object.prototype` or `null` are
 * wrapped, so class instances keep their identity and private-field semantics.
 */
function guardObjectMutations(
  schema: Schema,
  object: object,
  context: AssertionContext,
  session: MutationSession = createMutationSession(),
): object {
  if (mutationGuardProxies.has(object)) {
    return object;
  }
  const resolved = resolveReference(schema, context);
  if (resolved.kind !== 'object') {
    return object;
  }
  const prototype = Object.getPrototypeOf(object) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    return object;
  }
  const inProgress = sessionProxy(session, object, resolved);
  if (inProgress !== undefined) {
    return inProgress;
  }
  const existing = findCollectionMutationProxy(object, resolved, context);
  if (existing !== undefined) {
    return existing;
  }

  const properties = resolved.properties;
  const declaredProperty = (property: string | symbol): ObjectPropertySchema | undefined =>
    Object.prototype.hasOwnProperty.call(properties, property) ? properties[property] : undefined;
  const propertyMutationContext = (property: string | symbol): AssertionContext => ({
    ...nestedContext(context, property),
    operation: 'mutate',
  });
  // Same precedence as assert-value's validateObject: property-level policy
  // baked onto this schema > class-level (carried in the context) > global
  // default > 'error'. Index-signature keys and the third-party escape hatch
  // are never "extra".
  const ownerContext = withOwnerClassExtraPropertiesPolicy(context, object);
  const extraPolicy = (): 'error' | 'strip' | 'keep' => {
    if (resolved.index !== undefined || resolved.allowExtraProperties === true) {
      return 'keep';
    }
    return resolved.extraPropertiesPolicy ?? ownerContext.extraProperties ?? 'error';
  };
  const isNewKey = (target: object, property: string | symbol): boolean =>
    declaredProperty(property) === undefined && !Object.prototype.hasOwnProperty.call(target, property);

  const proxy: object = new Proxy(object, {
    set(target, property: string | symbol, nextValue: unknown): boolean {
      const declared = declaredProperty(property);
      if (declared !== undefined) {
        const propertyContext = propertyMutationContext(property);
        assertValue(declared.schema, nextValue, propertyContext);
        installProtection(declared.schema, nextValue, propertyContext, createProtectionState());
        const stored = wrapMutationValue(declared.schema, nextValue, propertyContext);
        return Reflect.set(target, property, stored, target);
      }
      if (isNewKey(target, property)) {
        const policy = extraPolicy();
        if (policy === 'strip') {
          // Silent no-op: report success without forwarding the write, so a
          // strict-mode assignment does not throw and the key never appears.
          return true;
        }
        if (policy === 'error') {
          const propertyContext = propertyMutationContext(property);
          throw new StrictTypeError({
            code: 'EXTRA_PROPERTY',
            ...(propertyContext.className === undefined ? {} : { className: propertyContext.className }),
            ...(propertyContext.functionName === undefined ? {} : { functionName: propertyContext.functionName }),
            contractKind: propertyContext.contractKind,
            propertyPath: propertyContext.propertyPath,
            expected: 'no extra properties',
            received: typeof nextValue,
            operation: 'mutate',
          });
        }
      }
      return Reflect.set(target, property, nextValue, target);
    },
    deleteProperty(target, property: string | symbol): boolean {
      const declared = declaredProperty(property);
      if (declared !== undefined && declared.optional !== true) {
        return false;
      }
      return Reflect.deleteProperty(target, property);
    },
    defineProperty(target, property: string | symbol, descriptor: PropertyDescriptor): boolean {
      const declared = declaredProperty(property);
      if (declared !== undefined && 'value' in descriptor) {
        const propertyContext = propertyMutationContext(property);
        if (!isValidValue(declared.schema, descriptor.value, propertyContext)) {
          return false;
        }
        installProtection(declared.schema, descriptor.value, propertyContext, createProtectionState());
        const stored = wrapMutationValue(declared.schema, descriptor.value, propertyContext);
        return Reflect.defineProperty(target, property, { ...descriptor, value: stored });
      }
      if (isNewKey(target, property)) {
        const policy = extraPolicy();
        if (policy === 'strip') {
          // A trap may only claim success for a property it did not add when
          // that property could still be configurable; refuse otherwise.
          return descriptor.configurable !== false;
        }
        if (policy === 'error') {
          return false;
        }
      }
      return Reflect.defineProperty(target, property, descriptor);
    },
  });

  rememberCollectionMutationProxy(object, resolved, context, proxy);
  rememberSessionProxy(session, object, resolved, proxy);
  wrapNestedObjectProperties(object, properties, context, session);
  return proxy;
}

/**
 * Non-throwing form of `assertValue`: reports a `StrictTypeError` mismatch as
 * `false` and rethrows anything else.
 */
function isValidValue(schema: Schema, value: unknown, context: AssertionContext): boolean {
  try {
    assertValue(schema, value, context);
    return true;
  } catch (error) {
    if (error instanceof StrictTypeError) {
      return false;
    }
    throw error;
  }
}

export function installFieldGuard(
  instance: object,
  key: PropertyKey,
  schema: Schema,
  context: AssertionContext,
  options: FieldGuardOptions,
): void {
  const ownerContext = withOwnerClassExtraPropertiesPolicy(
    isServerPopulated(instance) ? { ...context, isServerPopulated: true } : context,
    instance,
  );
  const fieldContext = withTypeErrorResponse(ownerContext, instance, key);
  const contract: GuardContract = {
    schema,
    context: fieldContext,
    // Property-level only. The owner's class-level policy travels in
    // `fieldContext.extraProperties` instead, so a field value's own
    // class-level decorator (checked in assert-value's validateObject) can
    // still override it: property > value's class > owner's class > global.
    extraPropertiesPolicy:
      options.extraPropertiesPolicy ?? getExtraPropertiesPolicy(instance, decoratorPropertyKey(key)),
  };
  const existingGuard = getInstalledGuard(instance, key);

  if (existingGuard !== undefined) {
    const shouldValidate = existingGuard.isInitialized || options.initialized;
    if (shouldValidate) {
      validateContract(contract, existingGuard.value, context.operation);
    }
    addContract(existingGuard, contract);
    existingGuard.isInitialized = shouldValidate;
    existingGuard.isReadonlyField = existingGuard.isReadonlyField || options.readonlyField === true;
    if (shouldValidate) {
      installContractProtection(contract, existingGuard.value, context.operation);
    }
    return;
  }

  const descriptor = Object.getOwnPropertyDescriptor(instance, key);
  if (isAccessorDescriptor(descriptor)) {
    if (options.initialized) {
      validateContract(contract, Reflect.get(instance, key), context.operation);
    }
    return;
  }

  const currentValue = descriptor === undefined ? undefined : descriptor.value;
  // A field with no inline initializer that keeps its PropertyDeclaration
  // in the output (decorated fields do, to preserve decorator emission —
  // see hasDecorators in create-contract-transformer.ts) is pre-defined by
  // native class fields as `undefined` before the constructor body runs,
  // which means a plain, non-accessor descriptor already exists here even
  // though nothing has really initialized it yet. Treating "a descriptor
  // exists" as "already handled by someone else" and bailing — the
  // previous behavior — silently skipped guard installation for every
  // such field, decorated or not. A real foreign value (anything other
  // than that `undefined` placeholder) is the only case worth treating as
  // already initialized here.
  const isInitialized = options.initialized || (descriptor !== undefined && currentValue !== undefined);
  // A ValueObject-typed field that already holds a raw string is converted
  // into its instance before the guard takes over, matching the setter path.
  const valueObjectCtor = valueObjectCtorOf(schema, fieldContext);
  const initialValue =
    isInitialized && valueObjectCtor !== undefined
      ? autoConstructValueObject(valueObjectCtor, currentValue, { ...fieldContext, operation: context.operation })
      : currentValue;
  if (isInitialized) {
    validateContract(contract, initialValue, context.operation);
    installContractProtection(contract, initialValue, context.operation);
  }

  installDataGuard(
    instance,
    key,
    initialValue,
    isInitialized,
    descriptor,
    contract,
    options.readonlyField === true,
  );
}

/**
 * Locks a `readonly` field installed by {@link installFieldGuard} with
 * `{readonlyField: true}` against further writes. The compiler calls this
 * once, as the last statement of the field's declaring class's own
 * constructor — matching TypeScript's own rule that a `readonly` field may
 * be (re)assigned any number of times while that constructor is still
 * running, and never again afterward. A key with no guard installed (for
 * example because {@link installFieldGuard} could not take over a
 * non-configurable property) is a harmless no-op: there is nothing to lock.
 */
export function lockReadonlyField(instance: object, key: PropertyKey): void {
  const guard = getInstalledGuard(instance, key);
  if (guard === undefined) {
    return;
  }
  if (deferredReadonlyLockDepth > 0) {
    pendingReadonlyLocks.push({ instance, key });
    return;
  }
  guard.isLocked = true;
}

let deferredReadonlyLockDepth = 0;
const pendingReadonlyLocks: { instance: object; key: PropertyKey }[] = [];

/**
 * Runs `fn` with every `readonly` field lock in this call tree deferred:
 * a constructor that finishes while `fn` is still running has its `readonly`
 * fields left writable, and the lock is applied only once the OUTERMOST
 * `withDeferredReadonlyLock` call returns. This is the sanctioned escape
 * hatch for framework integrations — like `class-transformer`'s
 * `plainToInstance`, which constructs an instance with no arguments and then
 * assigns payload keys onto it as separate, later property writes — that
 * need to populate a `readonly` field *after* construction as part of one
 * logical "build this instance" operation. Code that merely holds a
 * reference to an already-built instance and writes to it later, outside
 * this call, is unaffected and still rejected by the lock as soon as it is
 * applied.
 */
export function withDeferredReadonlyLock<T>(fn: () => T): T {
  deferredReadonlyLockDepth += 1;
  const settle = (): void => {
    deferredReadonlyLockDepth -= 1;
    if (deferredReadonlyLockDepth === 0 && pendingReadonlyLocks.length > 0) {
      const pending = pendingReadonlyLocks.splice(0, pendingReadonlyLocks.length);
      for (const { instance, key } of pending) {
        const guard = getInstalledGuard(instance, key);
        if (guard !== undefined) {
          guard.isLocked = true;
        }
      }
    }
  };

  let result: T;
  try {
    result = fn();
  } catch (error) {
    settle();
    throw error;
  }

  // `fn` may be async (e.g. a NestJS pipe's `transform`), in which case the
  // readonly writes it triggers happen synchronously inside it, well before
  // the returned promise settles — so deferring the sweep until then still
  // re-locks the fields before `fn`'s own caller observes the result.
  if (result instanceof Promise) {
    return result.then(
      (value) => {
        settle();
        return value;
      },
      (error: unknown) => {
        settle();
        throw error;
      },
    ) as T;
  }

  settle();
  return result;
}

/**
 * Makes a required field's guarded accessor non-configurable, so that
 * `delete instance.field` and `Object.defineProperty(instance, 'field', …)`
 * can no longer remove or replace it behind the guarded setter's back. The
 * compiler calls this once `new.target` confirms construction has reached
 * the most-derived class for this instance — never from a base class's own
 * constructor, and never unconditionally at install time in
 * {@link installFieldGuard} — because a subclass that redeclares this same
 * field re-initializes it through `[[DefineOwnProperty]]` semantics in ITS
 * OWN constructor (which runs after the base class constructor returns),
 * and that requires the property to still be configurable until then. A
 * missing or already non-configurable property is a harmless no-op.
 */
export function lockRequiredField(instance: object, key: PropertyKey): void {
  const descriptor = Object.getOwnPropertyDescriptor(instance, key);
  if (descriptor === undefined || descriptor.configurable === false) {
    return;
  }
  try {
    Object.defineProperty(instance, key, { configurable: false });
  } catch {
    // Non-configurable already, or the engine refused for an unrelated
    // reason (e.g. a proxy trap) — either way, nothing more to do here.
  }
}

function createProtectionState(metadataCache = new SchemaMetadataCache()): ProtectionState {
  return {
    visited: new Map<object, Set<Schema>>(),
    metadataCache,
  };
}

function validateContract(
  contract: GuardContract,
  value: unknown,
  operation: AssertionContext['operation'],
): void {
  const prepared = prepareContract(contract, value, operation);
  assertValue(prepared.schema, value, prepared.context);
}

function installContractProtection(
  contract: GuardContract,
  value: unknown,
  operation: AssertionContext['operation'],
): void {
  const prepared = prepareContract(contract, value, operation);
  installProtection(prepared.schema, value, prepared.context, createProtectionState());
}

function prepareContract(
  contract: GuardContract,
  value: unknown,
  operation: AssertionContext['operation'],
): PreparedContract {
  const context: AssertionContext = { ...contract.context, operation };
  let schema = contract.schema;

  if (contract.extraPropertiesPolicy !== undefined) {
    schema = applyFieldExtraPropertiesPolicy(schema, context, contract.extraPropertiesPolicy);
  }

  if (isReferenceValue(value) && !Array.isArray(value)) {
    schema = applyObjectDecoratorPermissions(schema, value, context);
  }

  return { schema, context };
}

function applyObjectDecoratorPermissions(
  schema: Schema,
  owner: object,
  context: AssertionContext,
): Schema {
  const resolved = resolveReference(schema, context);
  if (resolved.kind === 'object') {
    return prepareObjectSchema(resolved, owner, context);
  }
  if (resolved.kind === 'intersection') {
    return {
      kind: 'intersection',
      schemas: resolved.schemas.map((candidate) =>
        applyObjectDecoratorPermissions(candidate, owner, context),
      ),
    };
  }
  if (resolved.kind === 'union') {
    return {
      kind: 'union',
      schemas: resolved.schemas.map((candidate) =>
        applyObjectDecoratorPermissions(candidate, owner, context),
      ),
    };
  }
  return resolved;
}

/**
 * Bakes `owner`'s property-level `ExtraProperties(policy)` decorators into
 * the schemas of the fields they decorate. `owner`'s own class-level policy
 * is deliberately NOT written onto `schema.extraPropertiesPolicy` here: that
 * slot is reserved for a property-level override coming from whichever field
 * holds `owner`, and overwriting it would let class-level beat property-level.
 * The class-level policy is resolved in assert-value's validateObject instead,
 * below `schema.extraPropertiesPolicy` in precedence.
 */
function prepareObjectSchema(
  schema: ObjectSchema,
  owner: object,
  context: AssertionContext,
): ObjectSchema {
  const properties = clonePropertiesWithDecoratorPermissions(
    schema.properties,
    owner,
    context,
  );

  if (properties === schema.properties) {
    return schema;
  }

  return { ...schema, properties };
}

function clonePropertiesWithDecoratorPermissions(
  properties: SchemaProperties,
  owner: object,
  context: AssertionContext,
): SchemaProperties {
  let transformed: SchemaProperties | undefined;

  for (const key of Reflect.ownKeys(properties)) {
    const policy = getExtraPropertiesPolicy(owner, key);
    if (policy === undefined) {
      continue;
    }

    if (transformed === undefined) {
      transformed = cloneSchemaProperties(properties);
    }
    const property = properties[key];
    Object.defineProperty(transformed, key, {
      value: {
        ...property,
        schema: applyFieldExtraPropertiesPolicy(property.schema, context, policy),
      } satisfies ObjectPropertySchema,
      enumerable: true,
      configurable: true,
    });
  }

  return transformed ?? properties;
}

function cloneSchemaProperties(properties: SchemaProperties): SchemaProperties {
  const cloned: Record<PropertyKey, ObjectPropertySchema> = Object.create(null);

  for (const key of Reflect.ownKeys(properties)) {
    Object.defineProperty(cloned, key, {
      value: properties[key],
      enumerable: true,
      configurable: true,
    });
  }

  return cloned;
}

function applyFieldExtraPropertiesPolicy(
  schema: Schema,
  context: AssertionContext,
  policy: 'error' | 'strip',
): Schema {
  const resolved = resolveReference(schema, context);
  if (resolved.kind === 'array') {
    return { ...resolved, items: applyObjectExtraPropertiesPolicy(resolved.items, context, policy) };
  }
  if (resolved.kind === 'tuple') {
    return {
      ...resolved,
      items: resolved.items.map((item) => applyObjectExtraPropertiesPolicy(item, context, policy)),
      ...(resolved.rest === undefined || resolved.rest === false
        ? {}
        : { rest: applyObjectExtraPropertiesPolicy(resolved.rest, context, policy) }),
    };
  }
  return applyObjectExtraPropertiesPolicy(resolved, context, policy);
}

function applyObjectExtraPropertiesPolicy(
  schema: Schema,
  context: AssertionContext,
  policy: 'error' | 'strip',
): Schema {
  const resolved = resolveReference(schema, context);
  if (resolved.kind === 'object') {
    return { ...resolved, extraPropertiesPolicy: policy };
  }
  if (resolved.kind === 'intersection') {
    return {
      kind: 'intersection',
      schemas: resolved.schemas.map((candidate) =>
        applyObjectExtraPropertiesPolicy(candidate, context, policy),
      ),
    };
  }
  if (resolved.kind === 'union') {
    return {
      kind: 'union',
      schemas: resolved.schemas.map((candidate) =>
        applyObjectExtraPropertiesPolicy(candidate, context, policy),
      ),
    };
  }
  return resolved;
}

function installProtection(
  schema: Schema,
  value: unknown,
  context: AssertionContext,
  state: ProtectionState,
): void {
  if (!isReferenceValue(value)) {
    return;
  }
  if (wasVisited(value, schema, state)) {
    return;
  }

  if (schema.kind === 'ref') {
    installProtection(resolveReference(schema, context), value, context, state);
    return;
  }

  switch (schema.kind) {
    case 'object':
      if (!Array.isArray(value)) {
        installObjectProtection(schema, value, context, state);
      }
      return;
    case 'array':
      if (Array.isArray(value)) {
        installArrayItemProtection(schema, value, context, state);
      }
      return;
    case 'tuple':
      if (Array.isArray(value)) {
        installTupleItemProtection(schema, value, context, state);
      }
      return;
    case 'map':
      if (value instanceof Map) {
        installMapEntryProtection(schema, value, context, state);
      }
      return;
    case 'set':
      if (value instanceof Set) {
        installSetItemProtection(schema, value, context, state);
      }
      return;
    case 'intersection':
      for (const candidate of schema.schemas) {
        installProtection(candidate, value, context, state);
      }
      return;
    case 'union':
    case 'literal':
    case 'never':
    case 'primitive':
    case 'date':
    case 'function':
    case 'templateLiteral':
    case 'unknown':
      return;
  }
}

function installProtectionFromPlan(
  plan: readonly ProtectionPlanEntry[],
  metadataCache: SchemaMetadataCache,
): void {
  const state = createProtectionState(metadataCache);
  for (const entry of plan) {
    installProtectionTask(entry, state);
  }
}

function installProtectionTask(
  entry: ProtectionPlanEntry,
  state: ProtectionState,
): void {
  const resolved = resolveReference(entry.schema, entry.context);
  if (wasVisited(entry.value, resolved, state)) {
    return;
  }

  switch (resolved.kind) {
    case 'object':
      if (!Array.isArray(entry.value)) {
        installObjectProtection(resolved, entry.value, entry.context, state, false);
      }
      return;
    case 'intersection':
      for (const candidate of resolved.schemas) {
        installProtectionTask({ ...entry, schema: candidate }, state);
      }
      return;
    default:
      return;
  }
}

function installObjectProtection(
  schema: ObjectSchema,
  value: object,
  context: AssertionContext,
  state: ProtectionState,
  protectNested = true,
): void {
  const ownerContext = withOwnerClassExtraPropertiesPolicy(
    isServerPopulated(value) ? { ...context, isServerPopulated: true } : context,
    value,
  );

  const installer = state.metadataCache.getObjectProtectionInstaller(
    schema,
    value,
  );

  installCompiledObjectProperties(value, ownerContext, state, installer, protectNested);

  if (schema.index === undefined) {
    return;
  }

  const declaredKeys = state.metadataCache.getObjectMetadata(schema).declaredKeySet;

  for (const key of Reflect.ownKeys(value)) {
    if (declaredKeys.has(key)) {
      continue;
    }
    const propertyContext = nestedContext(context, key);
    const installedGuard = getInstalledGuard(value, key);
    if (installedGuard !== undefined) {
      addContractAndProtect(
        installedGuard,
        schema.index,
        false,
        propertyContext,
        value,
        key,
        state,
        protectNested,
      );
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || isAccessorDescriptor(descriptor)) {
      continue;
    }
    installKnownDataProperty(
      value,
      key,
      descriptor,
      schema.index,
      false,
      propertyContext,
      state,
      protectNested,
    );
  }
}

function installCompiledObjectProperties(
  value: object,
  ownerContext: AssertionContext,
  state: ProtectionState,
  installer: ObjectProtectionInstaller,
  protectNested: boolean,
): void {
  for (const property of installer.properties) {
    const propertyContext = withCachedTypeErrorResponse(
      { ...ownerContext, propertyPath: `${ownerContext.propertyPath}${property.pathSuffix}` },
      property.typeErrorResponse,
    );
    const installedGuard = getInstalledGuard(value, property.key);
    if (installedGuard !== undefined) {
      addContractAndProtect(
        installedGuard,
        property.schema,
        property.readonlyField,
        propertyContext,
        value,
        property.key,
        state,
        protectNested,
        property.extraPropertiesPolicy,
      );
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, property.key);
    if (descriptor === undefined || isAccessorDescriptor(descriptor)) {
      continue;
    }
    installKnownDataProperty(
      value,
      property.key,
      descriptor,
      property.schema,
      property.readonlyField,
      propertyContext,
      state,
      protectNested,
      property.extraPropertiesPolicy,
    );
  }
}

function addContractAndProtect(
  installedGuard: DataPropertyGuardState,
  schema: Schema,
  readonlyField: boolean,
  context: AssertionContext,
  owner: object,
  key: PropertyKey,
  state: ProtectionState,
  protectNested = true,
  extraPropertiesPolicyOverride?: 'error' | 'strip',
): void {
  const contract: GuardContract = {
    schema,
    context,
    extraPropertiesPolicy: extraPropertiesPolicyOverride ?? getExtraPropertiesPolicy(
      owner,
      decoratorPropertyKey(key),
    ),
  };
  addContract(installedGuard, contract);
  if (readonlyField) {
    lockStructuralReadonly(owner, key);
  }
  const prepared = prepareContract(contract, installedGuard.value, context.operation);
  if (protectNested) {
    installProtection(prepared.schema, installedGuard.value, prepared.context, state);
  }
}

function installKnownDataProperty(
  owner: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor,
  schema: Schema,
  readonlyField: boolean,
  context: AssertionContext,
  state: ProtectionState,
  protectNested = true,
  extraPropertiesPolicyOverride?: 'error' | 'strip',
): void {
  const contract: GuardContract = {
    schema,
    context,
    extraPropertiesPolicy: extraPropertiesPolicyOverride ?? getExtraPropertiesPolicy(
      owner,
      decoratorPropertyKey(key),
    ),
  };
  const prepared = prepareContract(contract, descriptor.value, context.operation);

  if (protectNested) {
    installProtection(prepared.schema, descriptor.value, prepared.context, state);
  }
  installDataGuard(owner, key, descriptor.value, true, descriptor, contract, readonlyField);
  if (readonlyField) {
    lockStructuralReadonly(owner, key);
  }
}

/**
 * Locks a `readonly` member of an interface/type-literal shape. Only applied
 * to plain object literals (prototype is `Object.prototype` or `null`): those
 * are complete when they cross a typed boundary, so there is no construction
 * phase to wait for. Class instances are skipped on purpose. Their own fields
 * may still be written by their methods, and a readonly view typed by an
 * interface must not freeze a class's mutable state.
 */
function lockStructuralReadonly(owner: object, key: PropertyKey): void {
  const prototype = Object.getPrototypeOf(owner) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    return;
  }
  lockReadonlyField(owner, key);
}

function installArrayItemProtection(
  schema: ArraySchema,
  value: readonly unknown[],
  context: AssertionContext,
  state: ProtectionState,
): void {
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || isAccessorDescriptor(descriptor)) {
      continue;
    }
    installProtection(
      schema.items,
      descriptor.value,
      indexedContext(context, index),
      state,
    );
  }
}

function installTupleItemProtection(
  schema: TupleSchema,
  value: readonly unknown[],
  context: AssertionContext,
  state: ProtectionState,
): void {
  for (let index = 0; index < value.length; index += 1) {
    const itemSchema =
      schema.items[index] ??
      (schema.rest === undefined || schema.rest === false ? undefined : schema.rest);
    if (itemSchema === undefined) {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || isAccessorDescriptor(descriptor)) {
      continue;
    }
    installProtection(
      itemSchema,
      descriptor.value,
      indexedContext(context, index),
      state,
    );
  }
}

/**
 * Protects the keys and values present when the contract is installed.
 * Entries added later through `.set()` are not intercepted (known limitation).
 */
function installMapEntryProtection(
  schema: MapSchema,
  value: Map<unknown, unknown>,
  context: AssertionContext,
  state: ProtectionState,
): void {
  const { typeErrorResponseMessage: _inheritedMessage, typeErrorResponseStatus: _inheritedStatus, ...entryContext } = context;
  let index = 0;
  for (const [key, entryValue] of value) {
    installProtection(schema.key, key, { ...entryContext, propertyPath: `${context.propertyPath}<${index}>.key` }, state);
    installProtection(schema.value, entryValue, { ...entryContext, propertyPath: `${context.propertyPath}<${index}>.value` }, state);
    index += 1;
  }
}

/**
 * Protects the items present when the contract is installed. Items added later
 * through `.add()` are not intercepted (known limitation).
 */
function installSetItemProtection(
  schema: SetSchema,
  value: Set<unknown>,
  context: AssertionContext,
  state: ProtectionState,
): void {
  let index = 0;
  for (const item of value) {
    installProtection(schema.item, item, indexedContext(context, index), state);
    index += 1;
  }
}

function installDataGuard(
  owner: object,
  key: PropertyKey,
  value: unknown,
  isInitialized: boolean,
  descriptor: PropertyDescriptor | undefined,
  contract: GuardContract,
  readonlyField: boolean,
): void {
  const existingGuard = getInstalledGuard(owner, key);
  if (existingGuard !== undefined) {
    addContract(existingGuard, contract);
    existingGuard.isInitialized = existingGuard.isInitialized || isInitialized;
    existingGuard.isReadonlyField = existingGuard.isReadonlyField || readonlyField;
    return;
  }

  if (!canInstallDataGuard(owner, descriptor)) {
    return;
  }

  const contracts: GuardContract[] = [contract];
  const guardState: DataPropertyGuardState = {
    contracts,
    value,
    isInitialized,
    isReadonlyField: readonlyField,
    isLocked: false,
  };
  const accessors = getSharedDataAccessors(key);

  try {
    // Always installed as configurable: a subclass that redeclares this
    // same field re-initializes it through `[[DefineOwnProperty]]` semantics
    // (native class fields, target >= ES2022) in ITS OWN constructor, which
    // requires the property to still be configurable at that point. Locking
    // a required field against `delete`/`Object.defineProperty` happens
    // later and separately, via {@link lockRequiredField}, once construction
    // has reached the most-derived class and no further redeclaration can
    // happen — see that function's own doc comment.
    Object.defineProperty(owner, key, {
      get: accessors.get,
      set: accessors.set,
      enumerable: descriptor?.enumerable ?? true,
      configurable: true,
    });
  } catch {
    return;
  }

  const guards = installedDataGuards.get(owner) ??
    new Map<PropertyKey, DataPropertyGuardState>();
  guards.set(key, guardState);
  installedDataGuards.set(owner, guards);
}

function addContract(
  state: DataPropertyGuardState,
  contract: GuardContract,
): void {
  if (state.contracts.some((existing) => contractsMatch(existing, contract))) {
    return;
  }
  state.contracts.push(contract);
}

function contractsMatch(
  left: GuardContract,
  right: GuardContract,
): boolean {
  return (
    left.schema === right.schema &&
    left.extraPropertiesPolicy === right.extraPropertiesPolicy &&
    left.context.propertyPath === right.context.propertyPath &&
    left.context.contractKind === right.context.contractKind &&
    left.context.className === right.context.className &&
    left.context.functionName === right.context.functionName &&
    left.context.registry === right.context.registry &&
    left.context.extraProperties === right.context.extraProperties &&
    left.context.isServerPopulated === right.context.isServerPopulated &&
    left.context.typeErrorResponseMessage === right.context.typeErrorResponseMessage &&
    left.context.typeErrorResponseStatus === right.context.typeErrorResponseStatus
  );
}

function setGuardedValue(state: DataPropertyGuardState, value: unknown, owner: object): void {
  if (state.isLocked) {
    const context = state.contracts[0]?.context;
    throw new StrictTypeError({
      code: 'READONLY_PROPERTY',
      ...(context?.className === undefined ? {} : { className: context.className }),
      ...(context?.functionName === undefined ? {} : { functionName: context.functionName }),
      contractKind: context?.contractKind ?? 'property',
      propertyPath: context?.propertyPath ?? '<unknown>',
      expected: 'no further writes',
      received: 'write attempt',
      operation: 'set',
    });
  }

  const preparedContracts = state.contracts.map((contract) =>
    prepareContract(contract, value, 'set'),
  );

  // A ValueObject-typed field stores the constructed instance, not the raw
  // value that was written. The first such contract decides the constructor.
  // ValueObject fields are not yet covered by the aggregate window below —
  // Task 4 decides whether (and how) they need to be.
  let stored: unknown = value;
  for (const prepared of preparedContracts) {
    const valueObjectCtor = valueObjectCtorOf(prepared.schema, prepared.context);
    if (valueObjectCtor !== undefined) {
      stored = autoConstructValueObject(valueObjectCtor, value, prepared.context);
      break;
    }
  }

  // The window check happens once, up front, and decides which loop runs —
  // never both. Running the non-throwing `assertValueCollecting` pass
  // unconditionally (even with no window open) would change observable
  // behavior for every instance today: it re-reads property getters an
  // extra time (visible for a throwing or side-effecting getter, and able to
  // silently turn a rejected write into a stored one when a getter's value
  // changes between reads), and it pays full-collection traversal cost
  // (e.g. building a violation per element of a huge invalid array) where
  // fail-fast would have stopped at the first failure. So when no window is
  // open — true for every instance until Task 4 wires construction to open
  // one — this takes the exact original loop, byte-for-byte.
  if (!isAggregating(owner)) {
    for (const prepared of preparedContracts) {
      if (valueObjectCtorOf(prepared.schema, prepared.context) !== undefined) {
        assertValue(prepared.schema, stored, prepared.context);
        continue;
      }
      assertValue(prepared.schema, value, prepared.context);
    }
  } else {
    // A window is open: collect violations instead of throwing — but ANY
    // failing contract for this write means the whole write is rejected
    // (matching fail-fast's "an invalid write never gets stored"), so every
    // contract is checked before deciding whether to proceed, instead of
    // validating and storing incrementally.
    let rejected = false;
    for (const prepared of preparedContracts) {
      const target = valueObjectCtorOf(prepared.schema, prepared.context) !== undefined ? stored : value;
      const violations = assertValueCollecting(prepared.schema, target, prepared.context);
      if (violations.length === 0) {
        continue;
      }
      let collected = false;
      for (const violation of violations) {
        if (collectIfAggregating(owner, violation)) {
          collected = true;
        }
      }
      if (collected) {
        rejected = true;
        continue;
      }
      // The window closed between the isAggregating check above and here —
      // not reachable today (nothing synchronous in between can close it),
      // but if it ever happens, fall back to the fail-fast throw rather than
      // silently proceeding.
      assertValue(prepared.schema, target, prepared.context);
    }
    if (rejected) {
      return;
    }
  }

  for (const prepared of preparedContracts) {
    if (valueObjectCtorOf(prepared.schema, prepared.context) !== undefined) {
      continue;
    }
    installProtection(
      prepared.schema,
      value,
      prepared.context,
      createProtectionState(),
    );
  }

  state.value = stored;
  state.isInitialized = true;
}

function getInstalledGuard(
  owner: object,
  key: PropertyKey,
): DataPropertyGuardState | undefined {
  const guard = installedDataGuards.get(owner)?.get(key);
  if (guard === undefined) {
    return undefined;
  }

  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  const accessors = getSharedDataAccessors(key);
  if (
    descriptor?.get !== accessors.get ||
    descriptor.set !== accessors.set
  ) {
    installedDataGuards.get(owner)?.delete(key);
    return undefined;
  }

  return guard;
}

function canInstallDataGuard(
  owner: object,
  descriptor: PropertyDescriptor | undefined,
): boolean {
  if (descriptor === undefined) {
    return Object.isExtensible(owner);
  }
  return (
    descriptor.configurable === true &&
    descriptor.writable === true &&
    !isAccessorDescriptor(descriptor)
  );
}

function isAccessorDescriptor(
  descriptor: PropertyDescriptor | undefined,
): boolean {
  return descriptor !== undefined && ('get' in descriptor || 'set' in descriptor);
}

function wasVisited(
  value: object,
  schema: Schema,
  state: ProtectionState,
): boolean {
  const schemas = state.visited.get(value) ?? new Set<Schema>();
  if (schemas.has(schema)) {
    return true;
  }
  schemas.add(schema);
  state.visited.set(value, schemas);
  return false;
}

function resolveReference(
  schema: Schema,
  context: AssertionContext,
): Schema {
  if (schema.kind !== 'ref') {
    return schema;
  }

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
    const target: Schema | undefined = context.registry?.get(current.name);
    if (target === undefined) {
      throw new Error(`SchemaRegistry has no schema named "${current.name}"`);
    }
    current = target;
  }

  return current;
}

function withTypeErrorResponse(
  context: AssertionContext,
  owner: object,
  key: PropertyKey,
): AssertionContext {
  // Response fields are per-property: drop any inherited from an enclosing
  // property so a decorated parent does not customize its nested children.
  const { typeErrorResponseMessage: _inheritedMessage, typeErrorResponseStatus: _inheritedStatus, ...inherited } = context;
  const response = getTypeErrorResponse(owner, decoratorPropertyKey(key));
  if (response === undefined) {
    return inherited;
  }
  return {
    ...inherited,
    typeErrorResponseMessage: response.message,
    ...(response.status === undefined ? {} : { typeErrorResponseStatus: response.status }),
  };
}

function withCachedTypeErrorResponse(
  context: AssertionContext,
  response: TypeErrorResponseOptions | undefined,
): AssertionContext {
  const { typeErrorResponseMessage: _inheritedMessage, typeErrorResponseStatus: _inheritedStatus, ...inherited } = context;
  if (response === undefined) {
    return inherited;
  }
  return {
    ...inherited,
    typeErrorResponseMessage: response.message,
    ...(response.status === undefined ? {} : { typeErrorResponseStatus: response.status }),
  };
}

function nestedContext(
  context: AssertionContext,
  key: PropertyKey,
): AssertionContext {
  return {
    ...context,
    propertyPath:
      typeof key === 'symbol'
        ? `${context.propertyPath}[${String(key)}]`
        : `${context.propertyPath}.${key}`,
  };
}

function indexedContext(
  context: AssertionContext,
  index: number,
): AssertionContext {
  // An array/tuple/Set item has no property key of its own to carry a
  // TypeErrorResponse, so a decorated collection field's own response must
  // not leak onto violations found inside its elements (same rule
  // `withTypeErrorResponse` enforces for object properties).
  const { typeErrorResponseMessage: _inheritedMessage, typeErrorResponseStatus: _inheritedStatus, ...inherited } = context;
  return { ...inherited, propertyPath: `${context.propertyPath}[${index}]` };
}

/**
 * Re-roots a violation collected via `takeAggregateWindowViolations` during
 * an array element's own construction so its `propertyPath` matches the
 * format the structural pass produces for the same element (e.g.
 * `"dtos[0].name"`, not `"CreateUserDto.name"`). A window violation's path
 * is set once, at property-descriptor install time, rooted at the owning
 * class's own name — it knows nothing about where in an array (if any) the
 * instance ends up, so it must be rewritten before merging it with
 * structural violations (which already carry the correct
 * `elementContext.propertyPath`-rooted path) for the same element. Used only
 * by the array-aggregation branch above; the single-object branch's window
 * violations are already correctly rooted and merged as-is.
 */
function reindexWindowViolation(
  violation: StrictTypeErrorInfo,
  elementContext: AssertionContext,
): StrictTypeErrorInfo {
  const dotIndex = violation.propertyPath.indexOf('.');
  const fieldPath = dotIndex === -1 ? violation.propertyPath : violation.propertyPath.slice(dotIndex + 1);
  return { ...violation, propertyPath: `${elementContext.propertyPath}.${fieldPath}` };
}

function isReferenceValue(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function decoratorPropertyKey(key: PropertyKey): string | symbol {
  return typeof key === 'number' ? String(key) : key;
}
