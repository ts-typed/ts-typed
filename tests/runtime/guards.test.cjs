'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const runtime = require('../../dist/runtime');
const guards = require('../../dist/runtime/guards');
const { assertValueWithSession } = require('../../dist/runtime/assert-value');
const { createTraversalSession } = require('../../dist/runtime/traversal-session');

const numberSchema = { kind: 'primitive', name: 'number' };
const stringSchema = { kind: 'primitive', name: 'string' };
const context = {
  contractKind: 'property',
  operation: 'initialize',
  propertyPath: 'Profile.value',
};

test('records one reusable protection task for each reference visited during validation', () => {
  const schema = {
    kind: 'array',
    items: {
      kind: 'object',
      properties: { count: { schema: numberSchema } },
    },
  };
  const value = [{ count: 1 }, { count: 2 }];
  const session = createTraversalSession(context);

  assertValueWithSession(schema, value, context, session);

  assert.equal(session.protectionPlan.length, 3);
  assert.strictEqual(session.protectionPlan[0].value, value);
  assert.strictEqual(session.protectionPlan[1].value, value[0]);
  assert.strictEqual(session.protectionPlan[2].value, value[1]);
});

test('protectValue returns the exact primitive or object identity after validation', () => {
  const value = { name: 'Ada' };
  const schema = {
    kind: 'object',
    properties: { name: { schema: stringSchema } },
  };

  assert.strictEqual(guards.protectValue(stringSchema, 'Ada', context), 'Ada');
  assert.strictEqual(guards.protectValue(schema, value, context), value);
  assert.throws(
    () => guards.protectValue(schema, { name: 42 }, context),
    runtime.StrictTypeError,
  );
});

test('object guards reject writes through aliases and Object.assign without changing the field', () => {
  const value = { name: 'Ada' };
  const schema = {
    kind: 'object',
    properties: { name: { schema: stringSchema } },
  };
  guards.protectValue(schema, value, context);

  assert.throws(() => {
    value.name = 42;
  }, runtime.StrictTypeError);
  assert.equal(value.name, 'Ada');
  assert.throws(() => Object.assign(value, { name: 42 }), runtime.StrictTypeError);
  assert.equal(value.name, 'Ada');

  value.name = 'Grace';
  assert.equal(value.name, 'Grace');
});

test('nested objects keep their original alias and reject incompatible nested writes', () => {
  const profile = { name: 'Ada' };
  const value = { profile };
  const schema = {
    kind: 'object',
    properties: {
      profile: {
        schema: {
          kind: 'object',
          properties: { name: { schema: stringSchema } },
        },
      },
    },
  };

  guards.protectValue(schema, value, context);

  assert.strictEqual(value.profile, profile);
  assert.throws(() => {
    profile.name = 7;
  }, runtime.StrictTypeError);
  assert.equal(profile.name, 'Ada');
});

test('object guards preserve configurable enumerable data-property descriptors', () => {
  const value = { count: 1 };
  const schema = {
    kind: 'object',
    properties: { count: { schema: numberSchema } },
  };

  guards.protectValue(schema, value, context);
  const descriptor = Object.getOwnPropertyDescriptor(value, 'count');

  assert.equal(descriptor.enumerable, true);
  assert.equal(descriptor.configurable, true);
  assert.equal(typeof descriptor.get, 'function');
  assert.equal(typeof descriptor.set, 'function');
});

test('reuses accessor functions across objects with the same guarded field', () => {
  const schema = {
    kind: 'object',
    properties: { count: { schema: numberSchema } },
  };
  const first = { count: 1 };
  const second = { count: 2 };

  guards.protectValue(schema, first, context);
  guards.protectValue(schema, second, context);

  const firstDescriptor = Object.getOwnPropertyDescriptor(first, 'count');
  const secondDescriptor = Object.getOwnPropertyDescriptor(second, 'count');

  assert.strictEqual(firstDescriptor.get, secondDescriptor.get);
  assert.strictEqual(firstDescriptor.set, secondDescriptor.set);
  first.count = 3;
  assert.equal(first.count, 3);
  assert.throws(() => {
    second.count = 'invalid';
  }, runtime.StrictTypeError);
  assert.equal(second.count, 2);
});

test('installFieldGuard rejects an invalid initializer before installing a guard', () => {
  const instance = { count: 'one' };

  assert.throws(
    () => guards.installFieldGuard(instance, 'count', numberSchema, context, { initialized: true }),
    runtime.StrictTypeError,
  );
  assert.deepEqual(Object.getOwnPropertyDescriptor(instance, 'count'), {
    value: 'one',
    writable: true,
    enumerable: true,
    configurable: true,
  });
});

test('installFieldGuard tolerates an uninitialized field and validates its first write', () => {
  const instance = {};
  guards.installFieldGuard(instance, 'count', numberSchema, context, { initialized: false });

  assert.equal(instance.count, undefined);
  assert.throws(() => {
    instance.count = 'one';
  }, runtime.StrictTypeError);
  assert.equal(instance.count, undefined);

  instance.count = 1;
  assert.equal(instance.count, 1);
});

test('reinstalling a field guard composes contracts instead of overwriting the first guard', () => {
  const instance = { value: 1 };
  const positiveNumberSchema = {
    kind: 'union',
    schemas: [{ kind: 'literal', value: 1 }, { kind: 'literal', value: 2 }],
  };
  guards.installFieldGuard(instance, 'value', numberSchema, context, { initialized: true });
  guards.installFieldGuard(instance, 'value', positiveNumberSchema, context, { initialized: true });

  instance.value = 2;
  assert.equal(instance.value, 2);
  assert.throws(() => {
    instance.value = 3;
  }, runtime.StrictTypeError);
  assert.throws(() => {
    instance.value = '1';
  }, runtime.StrictTypeError);
  assert.equal(instance.value, 2);
});

test('a shared object reference keeps every active object contract', () => {
  const shared = { value: 1 };
  const numberObject = {
    kind: 'object',
    properties: { value: { schema: numberSchema } },
  };
  const smallNumberObject = {
    kind: 'object',
    properties: {
      value: {
        schema: {
          kind: 'union',
          schemas: [{ kind: 'literal', value: 1 }, { kind: 'literal', value: 2 }],
        },
      },
    },
  };

  guards.protectValue(numberObject, shared, {
    ...context,
    propertyPath: 'first.shared',
  });
  guards.protectValue(smallNumberObject, shared, {
    ...context,
    propertyPath: 'second.shared',
  });

  shared.value = 2;
  assert.throws(() => {
    shared.value = 3;
  }, runtime.StrictTypeError);
  assert.equal(shared.value, 2);
});

test('field replacement validates closed object extras and preserves the previous value', () => {
  const previous = { name: 'Ada' };
  const instance = { profile: previous };
  const profileSchema = {
    kind: 'object',
    properties: { name: { schema: stringSchema } },
  };
  guards.installFieldGuard(instance, 'profile', profileSchema, context, { initialized: true });

  assert.throws(() => {
    instance.profile = { name: 'Grace', extra: true };
  }, runtime.StrictTypeError);
  assert.strictEqual(instance.profile, previous);
});

test('field guards preserve registry-backed references and nested error paths', () => {
  const registry = new runtime.SchemaRegistry();
  const nodeRef = { kind: 'ref', name: 'Node' };
  registry.define('Node', {
    kind: 'object',
    properties: {
      value: { schema: numberSchema },
      next: { schema: nodeRef, optional: true },
    },
  });
  const node = { value: 1 };
  node.next = node;

  guards.protectValue(nodeRef, node, { ...context, propertyPath: 'root', registry });

  assert.throws(
    () => {
      node.value = 'one';
    },
    (error) =>
      error instanceof runtime.StrictTypeError &&
      error.propertyPath === 'root.value' &&
      error.operation === 'set',
  );
});

test('frozen and non-configurable values are accepted after validation without guard installation', () => {
  const frozen = Object.freeze({ count: 1 });
  const nonConfigurable = {};
  Object.defineProperty(nonConfigurable, 'count', {
    value: 1,
    writable: true,
    enumerable: true,
    configurable: false,
  });
  const schema = {
    kind: 'object',
    properties: { count: { schema: numberSchema } },
  };

  assert.strictEqual(guards.protectValue(schema, frozen, context), frozen);
  assert.strictEqual(guards.protectValue(schema, nonConfigurable, context), nonConfigurable);
  assert.equal(Object.getOwnPropertyDescriptor(nonConfigurable, 'count').get, undefined);

  nonConfigurable.count = 'escaped';
  assert.equal(nonConfigurable.count, 'escaped');
  assert.throws(() => runtime.assertValue(schema, nonConfigurable, context), runtime.StrictTypeError);
});

test('accessor properties are read once for validation and left untouched', () => {
  let reads = 0;
  let stored = 1;
  const value = {};
  const getter = () => {
    reads += 1;
    return stored;
  };
  const setter = (next) => {
    stored = next;
  };
  Object.defineProperty(value, 'count', {
    get: getter,
    set: setter,
    enumerable: true,
    configurable: true,
  });
  const schema = {
    kind: 'object',
    properties: { count: { schema: numberSchema } },
  };

  guards.protectValue(schema, value, context);

  assert.equal(reads, 1);
  assert.strictEqual(Object.getOwnPropertyDescriptor(value, 'count').get, getter);
  value.count = 'escaped';
  assert.equal(stored, 'escaped');
});

test('array protection stays point-in-time while recursively guarding object elements', () => {
  const item = { name: 'Ada' };
  const values = [item];
  const schema = {
    kind: 'array',
    items: {
      kind: 'object',
      properties: { name: { schema: stringSchema } },
    },
  };

  assert.strictEqual(guards.protectValue(schema, values, context), values);
  assert.equal(Object.hasOwn(values, 'push'), false);
  assert.throws(() => {
    item.name = 42;
  }, runtime.StrictTypeError);

  values.push({ name: 42 });
  assert.equal(values.length, 2);
  assert.throws(() => runtime.assertValue(schema, values, context), runtime.StrictTypeError);
});

test('property and class extra-property decorators strip undeclared fields without opening known fields', () => {
  class Profile {}
  runtime.ExtraProperties('strip')(Profile);
  const classDecorated = Object.assign(new Profile(), { name: 'Ada', source: 'import' });
  const profileSchema = {
    kind: 'object',
    properties: { name: { schema: stringSchema } },
  };

  assert.strictEqual(guards.protectValue(profileSchema, classDecorated, context), classDecorated);
  assert.equal(Object.hasOwn(classDecorated, 'source'), false);
  assert.throws(() => {
    classDecorated.name = 42;
  }, runtime.StrictTypeError);

  class Owner {}
  runtime.ExtraProperties('strip')(Owner.prototype, 'profile');
  const owner = Object.assign(new Owner(), {
    profile: { name: 'Grace', source: 'import' },
  });
  guards.installFieldGuard(owner, 'profile', profileSchema, context, { initialized: true });

  assert.throws(() => {
    owner.profile = { name: 42, source: 'import' };
  }, runtime.StrictTypeError);
  owner.profile = { name: 'Lin', source: 'import' };
  assert.equal(Object.hasOwn(owner.profile, 'source'), false);
});

test('property-level extra-property decorator overrides a class-level error policy', () => {
  class Owner {}
  runtime.ExtraProperties('error')(Owner);
  runtime.ExtraProperties('strip')(Owner.prototype, 'profile');
  const profileSchema = {
    kind: 'object',
    properties: { name: { schema: stringSchema } },
  };
  const owner = Object.assign(new Owner(), { profile: { name: 'Grace', source: 'import' } });

  guards.installFieldGuard(owner, 'profile', profileSchema, context, { initialized: true });

  assert.equal(Object.hasOwn(owner.profile, 'source'), false);
});

test('TypeErrorResponse on a decorated array field does not leak into a later mutation violation on one of its items', () => {
  class Item {}
  const itemSchema = {
    kind: 'object',
    properties: { name: { schema: stringSchema } },
  };
  class Wrapper {}
  runtime.TypeErrorResponse('Itens inválidos', 409)(Wrapper.prototype, 'items');
  const wrapperSchema = {
    kind: 'object',
    properties: {
      items: { schema: { kind: 'array', items: itemSchema } },
    },
  };
  const item = Object.assign(new Item(), { name: 'Ada' });
  const wrapper = Object.assign(new Wrapper(), { items: [item] });

  guards.protectValue(wrapperSchema, wrapper, context);

  assert.throws(
    () => {
      item.name = 42;
    },
    (error) =>
      error instanceof runtime.StrictTypeError &&
      error.typeErrorResponseMessage === undefined &&
      error.typeErrorResponseStatus === undefined,
  );
});

test('protectValue aggregates every violation for a parameter whose runtime value is an @AggregateErrors() instance', () => {
  class CreateUserDto {}
  runtime.AggregateErrors()(CreateUserDto);
  const schema = {
    kind: 'object',
    properties: {
      name: { schema: stringSchema },
      age: { schema: numberSchema },
    },
  };
  const parameterContext = { contractKind: 'parameter', operation: 'argument', propertyPath: 'CreateUserDto' };
  const dto = Object.assign(new CreateUserDto(), { name: 42, age: 'old' });

  assert.throws(
    () => guards.protectValue(schema, dto, parameterContext),
    (error) => error instanceof runtime.AggregateStrictTypeError && error.errors.length === 2,
  );
});

test('protectValue aggregates even when schema.instanceOf is absent (the realistic cross-file DTO case)', () => {
  // The compiler only embeds schema.instanceOf when the DTO class is
  // declared in the same file as the parameter annotation — a DTO imported
  // from its own file (the normal case) never gets one. Detection must not
  // depend on it.
  class CreateUserDto {}
  runtime.AggregateErrors()(CreateUserDto);
  const schema = {
    kind: 'object',
    properties: {
      name: { schema: stringSchema },
      age: { schema: numberSchema },
    },
  };
  const parameterContext = { contractKind: 'parameter', operation: 'argument', propertyPath: 'CreateUserDto' };
  const dto = Object.assign(new CreateUserDto(), { name: 42, age: 'old' });

  assert.throws(
    () => guards.protectValue(schema, dto, parameterContext),
    (error) => error instanceof runtime.AggregateStrictTypeError,
  );
});

test('protectValue keeps fail-fast behavior for a parameter whose class has no @AggregateErrors()', () => {
  class PlainDto {}
  const schema = {
    kind: 'object',
    properties: {
      name: { schema: stringSchema },
      age: { schema: numberSchema },
    },
  };
  const parameterContext = { contractKind: 'parameter', operation: 'argument', propertyPath: 'PlainDto' };
  const dto = Object.assign(new PlainDto(), { name: 42, age: 'old' });

  assert.throws(
    () => guards.protectValue(schema, dto, parameterContext),
    (error) => error instanceof runtime.StrictTypeError && !(error instanceof runtime.AggregateStrictTypeError),
  );
});

test('protectValue aggregates nested object violations to full depth even without a decorator on the nested class', () => {
  class CreateUserDto {}
  runtime.AggregateErrors()(CreateUserDto);
  const schema = {
    kind: 'object',
    properties: {
      profile: {
        schema: {
          kind: 'object',
          properties: {
            bio: { schema: stringSchema },
            age: { schema: numberSchema },
          },
        },
      },
    },
  };
  const parameterContext = { contractKind: 'parameter', operation: 'argument', propertyPath: 'CreateUserDto' };
  const dto = Object.assign(new CreateUserDto(), { profile: { bio: 7, age: 'old' } });

  assert.throws(
    () => guards.protectValue(schema, dto, parameterContext),
    (error) => error instanceof runtime.AggregateStrictTypeError && error.errors.length === 2,
  );
});

test('field mutation after construction stays fail-fast even on an @AggregateErrors() instance', () => {
  class CreateUserDto {
    constructor() {
      this.name = '';
    }
  }
  runtime.AggregateErrors()(CreateUserDto);
  const instance = new CreateUserDto();
  guards.installFieldGuard(instance, 'name', stringSchema, context, { initialized: true });

  assert.throws(() => {
    instance.name = 42;
  }, runtime.StrictTypeError);
});

test('protectValue aggregates a plain object (no instance, no runtime decorator call) when the schema itself carries aggregateErrors: true', () => {
  // This is the realistic compiled-DTO scenario: ts-typed validates a
  // parameter structurally without instantiating it (SPEC §3.10), so the
  // value is a plain object literal, never `new CreateUserDto()`. The
  // schema carries the flag instead of relying on the runtime value's
  // prototype chain (that's Task 6 — this test hand-builds the schema to
  // prove protectValue honors the flag, independent of how it got there).
  const schema = {
    kind: 'object',
    properties: {
      name: { schema: stringSchema },
      age: { schema: numberSchema },
    },
    aggregateErrors: true,
  };
  const parameterContext = { contractKind: 'parameter', operation: 'argument', propertyPath: 'CreateUserDto' };

  assert.throws(
    () => guards.protectValue(schema, { name: 42, age: 'old' }, parameterContext),
    (error) => error instanceof runtime.AggregateStrictTypeError && error.errors.length === 2,
  );
});

test('protectValue stays fail-fast for a plain object whose schema has no aggregateErrors flag', () => {
  const schema = {
    kind: 'object',
    properties: {
      name: { schema: stringSchema },
      age: { schema: numberSchema },
    },
  };
  const parameterContext = { contractKind: 'parameter', operation: 'argument', propertyPath: 'PlainDto' };

  assert.throws(
    () => guards.protectValue(schema, { name: 42, age: 'old' }, parameterContext),
    (error) => error instanceof runtime.StrictTypeError && !(error instanceof runtime.AggregateStrictTypeError),
  );
});

test('protectValue aggregates a plain object when the PARAMETER\'S OWN schema is a union with one aggregateErrors:true object member (optional/nullable DTO parameter)', () => {
  // The parameter's own declared type is `CreateUserDto | undefined`, not
  // just a nested field being optional — so prepared.schema resolves
  // directly to a UnionSchema, not an ObjectSchema. Previously
  // schemaRequestsAggregation only ever checked `kind === 'object'` and so
  // was always false here, silently falling back to fail-fast (worse than
  // doing nothing: a single opaque "union" TYPE_MISMATCH instead of even a
  // normal per-field error).
  const schema = {
    kind: 'union',
    schemas: [
      {
        kind: 'object',
        properties: {
          name: { schema: stringSchema },
          age: { schema: numberSchema },
        },
        aggregateErrors: true,
      },
      { kind: 'primitive', name: 'undefined' },
    ],
  };
  const parameterContext = { contractKind: 'parameter', operation: 'argument', propertyPath: 'CreateUserDto' };

  assert.throws(
    () => guards.protectValue(schema, { name: 42, age: 'old' }, parameterContext),
    (error) => error instanceof runtime.AggregateStrictTypeError && error.errors.length === 2,
  );
});

test('protectValue does not falsely trigger aggregation for a genuinely ambiguous union of two aggregateErrors:true object schemas', () => {
  // Two different aggregateErrors:true object-shaped members in the same
  // union: which one's violations would even apply? schemaRequestsAggregation
  // deliberately does not guess (the filter requires exactly one match), so
  // this falls back to the ordinary isAggregateErrorsEnabled(value) runtime
  // check. A plain object literal carries no such runtime marker, so the
  // net effect here is ordinary fail-fast validation — asserted below: it
  // still throws (on the union mismatch, since this plain object satisfies
  // neither branch's required numeric-only `value`/`count` field), but never
  // as an AggregateStrictTypeError, and the call never throws or hangs from
  // trying to double-count across both branches.
  const schemaA = {
    kind: 'object',
    properties: { value: { schema: numberSchema } },
    aggregateErrors: true,
  };
  const schemaB = {
    kind: 'object',
    properties: { count: { schema: numberSchema } },
    aggregateErrors: true,
  };
  const schema = { kind: 'union', schemas: [schemaA, schemaB] };
  const parameterContext = { contractKind: 'parameter', operation: 'argument', propertyPath: 'Ambiguous' };

  assert.throws(
    () => guards.protectValue(schema, { value: 'nope' }, parameterContext),
    (error) => error instanceof runtime.StrictTypeError && !(error instanceof runtime.AggregateStrictTypeError),
  );
});

test('a field write on an instance with NO open aggregate window still throws immediately, unchanged (the default, fail-fast path)', () => {
  class PlainDto {
    constructor() {
      this.name = '';
    }
  }
  const instance = new PlainDto();
  guards.installFieldGuard(instance, 'name', stringSchema, context, { initialized: true });

  assert.throws(() => {
    instance.name = 42;
  }, (error) => error instanceof runtime.StrictTypeError && !(error instanceof runtime.AggregateStrictTypeError));
  // The rejected write did not change the field.
  assert.equal(instance.name, '');
});

test('a field write on an instance with an OPEN aggregate window collects instead of throwing, and keeps the field\'s old value', () => {
  class Dto {
    constructor() {
      this.name = '';
    }
  }
  runtime.AggregateErrors()(Dto);
  const instance = new Dto();
  guards.installFieldGuard(instance, 'name', stringSchema, context, { initialized: true });
  runtime.beginAggregateWindow(instance);

  assert.doesNotThrow(() => {
    instance.name = 42;
  });
  assert.equal(instance.name, '', 'the invalid write must not be stored');

  const violations = runtime.takeAggregateWindowViolations(instance);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].propertyPath, context.propertyPath);
  assert.equal(violations[0].code, 'TYPE_MISMATCH');
});

test('a VALID field write on an instance with an open aggregate window is stored normally, and nothing is collected', () => {
  class Dto {
    constructor() {
      this.name = '';
    }
  }
  runtime.AggregateErrors()(Dto);
  const instance = new Dto();
  guards.installFieldGuard(instance, 'name', stringSchema, context, { initialized: true });
  runtime.beginAggregateWindow(instance);

  instance.name = 'Ada';

  assert.equal(instance.name, 'Ada');
  assert.deepEqual(runtime.takeAggregateWindowViolations(instance), []);
});

test('a field write with one invalid nested value collects every structural violation while its aggregate window is open', () => {
  class Dto {
    constructor() {
      this.profile = { name: '', age: 0 };
    }
  }
  runtime.AggregateErrors()(Dto);
  const instance = new Dto();
  const profileSchema = {
    kind: 'object',
    properties: {
      name: { schema: stringSchema },
      age: { schema: numberSchema },
    },
  };
  guards.installFieldGuard(instance, 'profile', profileSchema, context, { initialized: true });
  runtime.beginAggregateWindow(instance);

  instance.profile = { name: 7, age: 'old' };

  assert.equal(instance.profile.name, '');
  assert.equal(instance.profile.age, 0);
  assert.equal(runtime.takeAggregateWindowViolations(instance).length, 2);
});

test('once the window is closed (takeAggregateWindowViolations called), a later field write goes back to immediate fail-fast', () => {
  class Dto {
    constructor() {
      this.name = '';
    }
  }
  runtime.AggregateErrors()(Dto);
  const instance = new Dto();
  guards.installFieldGuard(instance, 'name', stringSchema, context, { initialized: true });
  runtime.beginAggregateWindow(instance);
  runtime.takeAggregateWindowViolations(instance); // closes it

  assert.throws(() => {
    instance.name = 42;
  }, (error) => error instanceof runtime.StrictTypeError && !(error instanceof runtime.AggregateStrictTypeError));
});

test('a property with multiple contracts (shared reference) that have DIFFERENT contexts surfaces the first contract on the no-window path, and collects every contract on the open-window path', () => {
  class Dto {
    constructor() {
      this.value = 1;
    }
  }
  runtime.AggregateErrors()(Dto);
  const instance = new Dto();
  const firstContext = { ...context, propertyPath: 'First.value' };
  const secondContext = { ...context, propertyPath: 'Second.value' };
  // Composes two contracts on the same property, like the
  // "reinstalling a field guard composes contracts" test above, but with
  // distinct propertyPaths in each contract's own context instead of a
  // shared one.
  guards.installFieldGuard(instance, 'value', numberSchema, firstContext, { initialized: true });
  guards.installFieldGuard(instance, 'value', numberSchema, secondContext, { initialized: true });

  // No-window (fail-fast): the FIRST contract's propertyPath/expected are
  // what surfaces in the thrown error, since the loop stops there.
  assert.throws(() => {
    instance.value = 'not a number';
  }, (error) =>
    error instanceof runtime.StrictTypeError &&
    error.propertyPath === 'First.value' &&
    typeof error.expected === 'string');
  assert.equal(instance.value, 1, 'the rejected write did not change the field');

  // Open-window: both contracts' violations are collected, and the value is
  // not stored.
  runtime.beginAggregateWindow(instance);
  assert.doesNotThrow(() => {
    instance.value = 'not a number';
  });
  assert.equal(instance.value, 1, 'the rejected write did not change the field');
  const violations = runtime.takeAggregateWindowViolations(instance);
  assert.equal(violations.length, 2);
  assert.deepEqual(
    violations.map((violation) => violation.propertyPath).sort(),
    ['First.value', 'Second.value'],
  );
});

test('protectValue merges window violations (collected during a simulated plainToInstance population) with its own structural pass', () => {
  class CreateUserDto {
    constructor() {
      this.name = '';
      this.age = 0;
    }
  }
  runtime.AggregateErrors()(CreateUserDto);
  const schema = {
    kind: 'object',
    properties: {
      name: { schema: stringSchema },
      age: { schema: numberSchema },
    },
    instanceOf: CreateUserDto,
  };

  // Simulates exactly what class-transformer's plainToInstance does:
  // construct first (guards installed, defaults in place), THEN assign each
  // field — which is what Task 2 made collect instead of throw, given an
  // open window.
  const instance = new CreateUserDto();
  guards.installFieldGuard(instance, 'name', stringSchema, context, { initialized: true });
  guards.installFieldGuard(instance, 'age', numberSchema, context, { initialized: true });
  runtime.beginAggregateWindow(instance);
  instance.name = 42; // collected, not thrown (Task 2)
  instance.age = 'old'; // collected, not thrown (Task 2)

  const parameterContext = { contractKind: 'parameter', operation: 'argument', propertyPath: 'CreateUserDto' };

  assert.throws(
    () => guards.protectValue(schema, instance, parameterContext),
    (error) => {
      assert.ok(error instanceof runtime.AggregateStrictTypeError);
      assert.equal(error.errors.length, 2);
      assert.deepEqual(error.errors.map((e) => e.propertyPath).sort(), [context.propertyPath, context.propertyPath].sort());
      return true;
    },
  );
});

test('protectValue ALSO reports a missing required field via its own structural pass, merged alongside window violations', () => {
  class CreateUserDto {
    constructor() {
      this.name = '';
      this.age = 0;
    }
  }
  runtime.AggregateErrors()(CreateUserDto);
  const schema = {
    kind: 'object',
    properties: {
      name: { schema: stringSchema },
      age: { schema: numberSchema },
      email: { schema: stringSchema }, // never written at all — required, missing
    },
    instanceOf: CreateUserDto,
  };

  const instance = new CreateUserDto();
  guards.installFieldGuard(instance, 'name', stringSchema, context, { initialized: true });
  guards.installFieldGuard(instance, 'age', numberSchema, context, { initialized: true });
  runtime.beginAggregateWindow(instance);
  instance.name = 42; // collected (window)

  const parameterContext = { contractKind: 'parameter', operation: 'argument', propertyPath: 'CreateUserDto' };

  assert.throws(
    () => guards.protectValue(schema, instance, parameterContext),
    (error) => {
      assert.ok(error instanceof runtime.AggregateStrictTypeError);
      const codes = error.errors.map((e) => e.code).sort();
      assert.deepEqual(codes, ['REQUIRED_PROPERTY', 'TYPE_MISMATCH']);
      return true;
    },
  );
});

test('a window violation under strip policy leaves an otherwise-strippable extra property untouched (rejected values come back unmutated)', () => {
  class CreateUserDto {
    constructor() {
      this.name = '';
    }
  }
  runtime.AggregateErrors()(CreateUserDto);
  const schema = {
    kind: 'object',
    properties: { name: { schema: stringSchema } },
    instanceOf: CreateUserDto,
  };

  const instance = new CreateUserDto();
  guards.installFieldGuard(instance, 'name', stringSchema, context, { initialized: true });
  runtime.beginAggregateWindow(instance);
  instance.name = 42; // collected window violation, not thrown

  instance.stray = 'drop-me'; // undeclared extra property, would be strippable on its own

  const parameterContext = {
    contractKind: 'parameter',
    operation: 'argument',
    propertyPath: 'CreateUserDto',
    extraProperties: 'strip',
  };

  assert.throws(
    () => guards.protectValue(schema, instance, parameterContext),
    (error) => error instanceof runtime.AggregateStrictTypeError,
  );
  // The structural pass alone found nothing to reject, but the window
  // violation makes the overall result a rejection — so its pending strip
  // must not have been committed.
  assert.equal(Object.hasOwn(instance, 'stray'), true);
});

test('protectValue closes the window: a second protectValue call on the same (now otherwise-valid) instance does not re-report anything', () => {
  class CreateUserDto {
    constructor() {
      this.name = '';
    }
  }
  runtime.AggregateErrors()(CreateUserDto);
  const schema = {
    kind: 'object',
    properties: { name: { schema: stringSchema } },
    instanceOf: CreateUserDto,
  };
  const instance = new CreateUserDto();
  guards.installFieldGuard(instance, 'name', stringSchema, context, { initialized: true });
  runtime.beginAggregateWindow(instance);
  instance.name = 'Ada'; // valid, nothing collected

  const parameterContext = { contractKind: 'parameter', operation: 'argument', propertyPath: 'CreateUserDto' };
  assert.doesNotThrow(() => guards.protectValue(schema, instance, parameterContext));

  // Window is closed now. A later field write goes back to immediate fail-fast.
  assert.throws(() => {
    instance.name = 42;
  }, (error) => error instanceof runtime.StrictTypeError && !(error instanceof runtime.AggregateStrictTypeError));
});

// --- extraProperties policy: final-review regressions --------------------------------------

const policyProfileSchema = {
  kind: 'object',
  properties: { name: { schema: stringSchema } },
};

function extraPropertyCode(action) {
  try {
    action();
  } catch (error) {
    return error.code ?? error.violations?.[0]?.code;
  }
  return undefined;
}

test('property-level error policy beats the value class strip policy through installFieldGuard', () => {
  class Profile {}
  runtime.ExtraProperties('strip')(Profile);
  class Owner {}
  runtime.ExtraProperties('error')(Owner.prototype, 'profile');
  const owner = new Owner();
  owner.profile = Object.assign(new Profile(), { name: 'Ada', source: 'import' });

  assert.equal(
    extraPropertyCode(() =>
      guards.installFieldGuard(owner, 'profile', policyProfileSchema, context, { initialized: true }),
    ),
    'EXTRA_PROPERTY',
  );
  assert.equal(Object.hasOwn(owner.profile, 'source'), true);
});

test('property-level error policy beats a global strip default through installFieldGuard', () => {
  class Owner {}
  runtime.ExtraProperties('error')(Owner.prototype, 'profile');
  const owner = Object.assign(new Owner(), { profile: { name: 'Ada', source: 'import' } });

  assert.equal(
    extraPropertyCode(() =>
      guards.installFieldGuard(
        owner,
        'profile',
        policyProfileSchema,
        { ...context, extraProperties: 'strip' },
        { initialized: true },
      ),
    ),
    'EXTRA_PROPERTY',
  );
  assert.equal(Object.hasOwn(owner.profile, 'source'), true);
});

test('property-level error policy beats the value class strip policy through assertValue', () => {
  class Profile {}
  runtime.ExtraProperties('strip')(Profile);
  const value = Object.assign(new Profile(), { name: 'Ada', source: 'import' });

  assert.equal(
    extraPropertyCode(() =>
      runtime.assertValue({ ...policyProfileSchema, extraPropertiesPolicy: 'error' }, value, context),
    ),
    'EXTRA_PROPERTY',
  );
  assert.equal(Object.hasOwn(value, 'source'), true);
});

test('the value class policy beats the global default in both directions', () => {
  class Strict {}
  runtime.ExtraProperties('error')(Strict);
  class Loose {}
  runtime.ExtraProperties('strip')(Loose);

  const strict = Object.assign(new Strict(), { name: 'Ada', source: 'import' });
  assert.equal(
    extraPropertyCode(() =>
      runtime.assertValue(policyProfileSchema, strict, { ...context, extraProperties: 'strip' }),
    ),
    'EXTRA_PROPERTY',
  );

  const loose = Object.assign(new Loose(), { name: 'Ada', source: 'import' });
  runtime.assertValue(policyProfileSchema, loose, context);
  assert.equal(Object.hasOwn(loose, 'source'), false);
});

test('an array element class strip policy applies inside a field guard without a field-level policy', () => {
  class Item {}
  runtime.ExtraProperties('strip')(Item);
  class Owner {}
  const owner = new Owner();
  owner.items = [Object.assign(new Item(), { name: 'Ada', source: 'import' })];

  guards.installFieldGuard(
    owner,
    'items',
    { kind: 'array', items: policyProfileSchema },
    context,
    { initialized: true },
  );

  assert.equal(Object.hasOwn(owner.items[0], 'source'), false);
});

test('an index-signature object under strip keeps every key', () => {
  const value = { a: 'x', b: 'y' };
  runtime.assertValue(
    { kind: 'object', properties: {}, index: stringSchema },
    value,
    { ...context, extraProperties: 'strip' },
  );
  assert.deepEqual(value, { a: 'x', b: 'y' });
});

test('union branch selection does not depend on the strip policy', () => {
  const optionalX = {
    kind: 'object',
    properties: { x: { schema: stringSchema, optional: true } },
  };
  const requiredY = { kind: 'object', properties: { y: { schema: stringSchema } } };
  const union = { kind: 'union', schemas: [optionalX, requiredY] };

  const exact = { y: 'keep' };
  runtime.assertValue(union, exact, { ...context, extraProperties: 'strip' });
  assert.deepEqual(exact, { y: 'keep' });

  // No exact branch: `optionalX` (tried first) could also be satisfied by
  // stripping both `y` and `z`, but that destroys declared data. `requiredY`
  // only needs to strip `z` to fit, so it must win even though it is tried
  // second — the strip-tolerant pass picks the candidate needing fewest
  // strips, not simply the first one that happens to tolerate stripping.
  const needsStrip = { y: 'keep', z: 'drop' };
  runtime.assertValue(union, needsStrip, { ...context, extraProperties: 'strip' });
  assert.equal(Object.hasOwn(needsStrip, 'z'), false);
  assert.equal(needsStrip.y, 'keep');
});

test('a failed validation under strip leaves the value unmutated', () => {
  const schema = {
    kind: 'object',
    properties: {
      profile: { schema: policyProfileSchema },
      label: { schema: stringSchema },
    },
  };
  const value = { profile: { name: 'Ada', source: 'import' }, label: 5, stray: true };

  assert.throws(
    () => runtime.assertValue(schema, value, { ...context, extraProperties: 'strip' }),
    runtime.StrictTypeError,
  );
  assert.equal(Object.hasOwn(value.profile, 'source'), true);
  assert.equal(Object.hasOwn(value, 'stray'), true);
});

test('mutation guard set trap silently drops undeclared writes under strip', () => {
  const proxy = guards.protectValue(policyProfileSchema, { name: 'Ada' }, {
    ...context,
    extraProperties: 'strip',
    enforceMutationGuards: true,
  });

  proxy.source = 'import';
  assert.equal(Object.hasOwn(proxy, 'source'), false);
  assert.equal(Reflect.defineProperty(proxy, 'other', { value: 1, configurable: true }), true);
  assert.equal(Object.hasOwn(proxy, 'other'), false);
  proxy.name = 'Grace';
  assert.equal(proxy.name, 'Grace');
});

test('mutation guard set trap rejects undeclared writes under error', () => {
  const proxy = guards.protectValue(policyProfileSchema, { name: 'Ada' }, {
    ...context,
    enforceMutationGuards: true,
  });

  assert.equal(extraPropertyCode(() => { proxy.source = 'import'; }), 'EXTRA_PROPERTY');
  assert.equal(Object.hasOwn(proxy, 'source'), false);
  assert.equal(Reflect.defineProperty(proxy, 'other', { value: 1, configurable: true }), false);
});
