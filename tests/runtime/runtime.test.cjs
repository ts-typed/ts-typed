'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const packageRuntime = require('@ts-typed/core');
const runtime = require('../../dist/runtime');

const context = {
  contractKind: 'expression',
  operation: 'assert',
  propertyPath: 'value',
};

const numberSchema = { kind: 'primitive', name: 'number' };
const stringSchema = { kind: 'primitive', name: 'string' };

test('the package root and runtime path share public error and validator identities', () => {
  assert.strictEqual(packageRuntime.StrictTypeError, runtime.StrictTypeError);
  assert.strictEqual(packageRuntime.assertValue, runtime.assertValue);
});

test('primitive schemas reject incompatible values without coercion', () => {
  assert.doesNotThrow(() => runtime.assertValue(stringSchema, 'ok', context));
  assert.throws(
    () => runtime.assertValue(stringSchema, 42, context),
    (error) => error instanceof runtime.StrictTypeError && error.code === 'TYPE_MISMATCH',
  );
});

test('validating an array reuses object-schema metadata during one traversal', () => {
  const schema = {
    kind: 'array',
    items: {
      kind: 'object',
      properties: {
        id: { schema: numberSchema },
        email: { schema: stringSchema },
      },
    },
  };
  const values = Array.from({ length: 4 }, (_, index) => ({
    id: index,
    email: `user-${index}@example.com`,
  }));
  const originalOwnKeys = Reflect.ownKeys;
  let schemaPropertyLookups = 0;

  Reflect.ownKeys = (target) => {
    if (target === schema.items.properties) {
      schemaPropertyLookups += 1;
    }
    return originalOwnKeys(target);
  };

  try {
    runtime.assertValue(schema, values, context);
  } finally {
    Reflect.ownKeys = originalOwnKeys;
  }

  assert.equal(schemaPropertyLookups, 1);
});

test('literal schemas use TypeScript equality for zero and reject impossible NaN literals', () => {
  assert.doesNotThrow(() => runtime.assertValue({ kind: 'literal', value: -0 }, 0, context));
  assert.throws(
    () => runtime.assertValue({ kind: 'literal', value: Number.NaN }, Number.NaN, context),
    runtime.StrictTypeError,
  );
});

test('unions accept a matching branch and reject values outside every branch', () => {
  const schema = { kind: 'union', schemas: [stringSchema, numberSchema] };

  assert.doesNotThrow(() => runtime.assertValue(schema, 3, context));
  assert.throws(() => runtime.assertValue(schema, false, context), runtime.StrictTypeError);
});

test('unions preserve the identity of errors thrown by getters', () => {
  const getterError = new TypeError('getter failed');
  const value = {};
  Object.defineProperty(value, 'name', {
    enumerable: true,
    get() {
      throw getterError;
    },
  });
  const schema = {
    kind: 'union',
    schemas: [
      { kind: 'object', properties: { name: { schema: stringSchema } } },
      { kind: 'literal', value: null },
    ],
  };

  assert.throws(() => runtime.assertValue(schema, value, context), (error) => error === getterError);
});

test('union branches validate cyclic objects independently', () => {
  const registry = new runtime.SchemaRegistry();
  const nodeRef = { kind: 'ref', name: 'Node' };
  registry.define('Node', {
    kind: 'union',
    schemas: [
      {
        kind: 'object',
        properties: {
          kind: { schema: { kind: 'literal', value: 'leaf' } },
          next: { schema: nodeRef, optional: true },
        },
      },
      {
        kind: 'object',
        properties: {
          kind: { schema: { kind: 'literal', value: 'branch' } },
          next: { schema: nodeRef, optional: true },
        },
      },
    ],
  });
  const branch = { kind: 'branch' };
  branch.next = branch;
  const invalid = { kind: 'invalid' };
  invalid.next = invalid;

  assert.doesNotThrow(() => runtime.assertValue(nodeRef, branch, { ...context, registry }));
  assert.throws(
    () => runtime.assertValue(nodeRef, invalid, { ...context, registry }),
    runtime.StrictTypeError,
  );
});

test('object intersections enforce every schema declared for the same property', () => {
  const schema = {
    kind: 'intersection',
    schemas: [
      { kind: 'object', properties: { value: { schema: stringSchema } } },
      { kind: 'object', properties: { value: { schema: numberSchema } } },
    ],
  };

  assert.throws(() => runtime.assertValue(schema, { value: 1 }, context), runtime.StrictTypeError);
  assert.throws(() => runtime.assertValue(schema, { value: 'one' }, context), runtime.StrictTypeError);
});

test('object intersections combine distinct keys without treating them as extras', () => {
  const schema = {
    kind: 'intersection',
    schemas: [
      { kind: 'object', properties: { name: { schema: stringSchema } } },
      { kind: 'object', properties: { age: { schema: numberSchema } } },
    ],
  };

  assert.doesNotThrow(() => runtime.assertValue(schema, { name: 'Ada', age: 36 }, context));
  assert.throws(
    () => runtime.assertValue(schema, { name: 'Ada', age: 36, extra: true }, context),
    (error) => error instanceof runtime.StrictTypeError && error.code === 'EXTRA_PROPERTY',
  );
});

test('object intersections preserve own __proto__ and constructor schema keys', () => {
  const specialProperties = Object.fromEntries([
    ['__proto__', { schema: stringSchema }],
    ['constructor', { schema: numberSchema }],
  ]);
  const value = Object.fromEntries([
    ['__proto__', 'safe'],
    ['constructor', 1],
  ]);
  const schema = {
    kind: 'intersection',
    schemas: [
      { kind: 'object', properties: specialProperties },
      { kind: 'object', properties: {} },
    ],
  };

  assert.doesNotThrow(() => runtime.assertValue(schema, value, context));
  assert.throws(
    () => runtime.assertValue(schema, { ...value, constructor: 'unsafe' }, context),
    runtime.StrictTypeError,
  );
});

test('object schemas require and validate declared symbol properties', () => {
  const identifier = Symbol('identifier');
  const schema = {
    kind: 'object',
    properties: {
      [identifier]: { schema: numberSchema },
    },
  };

  assert.doesNotThrow(() => runtime.assertValue(schema, { [identifier]: 7 }, context));
  assert.throws(
    () => runtime.assertValue(schema, {}, context),
    (error) => error instanceof runtime.StrictTypeError && error.code === 'REQUIRED_PROPERTY',
  );
  assert.throws(
    () => runtime.assertValue(schema, { [identifier]: '7' }, context),
    (error) => error instanceof runtime.StrictTypeError && error.code === 'TYPE_MISMATCH',
  );
});

test('closed object schemas reject undeclared symbol and non-enumerable properties', () => {
  const extraSymbol = Symbol('extra');
  const symbolValue = { name: 'Ada', [extraSymbol]: true };
  const hiddenValue = { name: 'Ada' };
  Object.defineProperty(hiddenValue, 'secret', { value: true });
  const schema = {
    kind: 'object',
    properties: { name: { schema: stringSchema } },
  };

  assert.throws(() => runtime.assertValue(schema, symbolValue, context), runtime.StrictTypeError);
  assert.throws(() => runtime.assertValue(schema, hiddenValue, context), runtime.StrictTypeError);
});

test('optional object properties distinguish absence from an explicit invalid undefined', () => {
  const schema = {
    kind: 'object',
    properties: { name: { schema: stringSchema, optional: true } },
  };

  assert.doesNotThrow(() => runtime.assertValue(schema, {}, context));
  assert.throws(() => runtime.assertValue(schema, { name: undefined }, context), runtime.StrictTypeError);
});

test('array schemas reject sparse and incompatible elements', () => {
  const sparse = [];
  sparse.length = 1;
  const schema = { kind: 'array', items: numberSchema };

  assert.throws(() => runtime.assertValue(schema, sparse, context), runtime.StrictTypeError);
  assert.throws(() => runtime.assertValue(schema, [1, '2'], context), runtime.StrictTypeError);
});

test('array schemas reject extra own string, symbol, and non-enumerable properties by default', () => {
  const extraSymbol = Symbol('extra');
  const withString = [1];
  const withSymbol = [1];
  const withHidden = [1];
  withString.label = 'numbers';
  withSymbol[extraSymbol] = true;
  Object.defineProperty(withHidden, 'hidden', { value: true });
  const schema = { kind: 'array', items: numberSchema };

  assert.throws(() => runtime.assertValue(schema, withString, context), runtime.StrictTypeError);
  assert.throws(() => runtime.assertValue(schema, withSymbol, context), runtime.StrictTypeError);
  assert.throws(() => runtime.assertValue(schema, withHidden, context), runtime.StrictTypeError);
});

test('global extra-property permission leaves array element validation active', () => {
  const value = [1];
  value.label = 'numbers';
  const schema = { kind: 'array', items: numberSchema };
  const permissiveContext = { ...context, allowExtraPropertiesAll: true };

  assert.doesNotThrow(() => runtime.assertValue(schema, value, permissiveContext));
  assert.throws(() => runtime.assertValue(schema, [1, '2'], permissiveContext), runtime.StrictTypeError);
});

test('tuples enforce fixed length and declared rest element schemas', () => {
  const fixed = { kind: 'tuple', items: [numberSchema] };
  const withRest = { kind: 'tuple', items: [stringSchema], rest: numberSchema };

  assert.throws(() => runtime.assertValue(fixed, [1, 2], context), runtime.StrictTypeError);
  assert.doesNotThrow(() => runtime.assertValue(withRest, ['count', 1, 2], context));
  assert.throws(() => runtime.assertValue(withRest, ['count', '1'], context), runtime.StrictTypeError);
});

test('references validate recursive cyclic objects through a concrete schema witness', () => {
  const registry = new runtime.SchemaRegistry();
  const nodeRef = { kind: 'ref', name: 'Node' };
  registry.define('Node', {
    kind: 'object',
    properties: {
      value: { schema: numberSchema },
      next: { schema: nodeRef, optional: true },
    },
  });
  const cyclic = { value: 1 };
  cyclic.next = cyclic;
  const invalid = { value: '1' };
  invalid.next = invalid;

  assert.doesNotThrow(() => runtime.assertValue(nodeRef, cyclic, { ...context, registry }));
  assert.throws(
    () => runtime.assertValue(nodeRef, invalid, { ...context, registry }),
    runtime.StrictTypeError,
  );
});

test('missing references fail as registry errors instead of type mismatches', () => {
  const registry = new runtime.SchemaRegistry();

  assert.throws(
    () => runtime.assertValue({ kind: 'ref', name: 'Missing' }, {}, { ...context, registry }),
    (error) =>
      error instanceof Error &&
      !(error instanceof runtime.StrictTypeError) &&
      /Missing/.test(error.message),
  );
});

test('reference-only cycles fail when the registry has no concrete schema witness', () => {
  const registry = new runtime.SchemaRegistry();
  registry.define('First', { kind: 'ref', name: 'Second' });
  registry.define('Second', { kind: 'ref', name: 'First' });

  assert.throws(
    () => runtime.assertValue({ kind: 'ref', name: 'First' }, {}, { ...context, registry }),
    (error) =>
      error instanceof Error &&
      !(error instanceof runtime.StrictTypeError) &&
      /First/.test(error.message) &&
      /Second/.test(error.message),
  );
});

test('StrictTypeError preserves TypeError identity and serializes no received value or stack', () => {
  let caught;
  try {
    runtime.assertValue(stringSchema, { password: 'sensitive' }, {
      ...context,
      className: 'Profile',
      functionName: 'update',
      propertyPath: 'Profile.name',
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof runtime.StrictTypeError);
  assert.ok(caught instanceof TypeError);
  assert.equal(caught.name, 'StrictTypeError');
  assert.deepEqual(caught.toJSON(), {
    code: 'TYPE_MISMATCH',
    className: 'Profile',
    functionName: 'update',
    contractKind: 'expression',
    propertyPath: 'Profile.name',
    expected: 'string',
    received: 'object',
    operation: 'assert',
  });
  assert.doesNotMatch(JSON.stringify(caught), /sensitive|password|stack/i);
});

test('class and property decorator policy metadata are inherited', () => {
  const profile = Symbol('profile');
  class Base {}
  class Derived extends Base {}
  runtime.ExtraProperties('strip')(Base);
  runtime.ExtraProperties('strip')(Base.prototype, profile);

  const instance = new Derived();
  assert.equal(runtime.getExtraPropertiesPolicy(instance), 'strip');
  assert.equal(runtime.getExtraPropertiesPolicy(instance, profile), 'strip');
  assert.equal(runtime.getExtraPropertiesPolicy(instance, Symbol('other')), undefined);
});

test('assertValue performs point-in-time validation without installing mutation guards', () => {
  const value = { name: 'Ada' };
  const schema = {
    kind: 'object',
    properties: { name: { schema: stringSchema } },
  };

  runtime.assertValue(schema, value, context);
  assert.doesNotThrow(() => {
    value.name = 42;
  });
  assert.throws(() => runtime.assertValue(schema, value, context), runtime.StrictTypeError);
});

test('branded primitives accept the primitive value without requiring the phantom object member', () => {
  const brandMarker = {
    kind: 'object',
    properties: { __brand: { schema: { kind: 'literal', value: 'Id' } } },
  };
  const schema = { kind: 'intersection', schemas: [stringSchema, brandMarker] };

  assert.doesNotThrow(() => runtime.assertValue(schema, 'abc', context));
  assert.throws(
    () => runtime.assertValue(schema, 123, context),
    (error) => error instanceof runtime.StrictTypeError && error.code === 'TYPE_MISMATCH',
  );
});

test('branded number primitives keep enforcing the primitive member', () => {
  const brandMarker = {
    kind: 'object',
    properties: { __brand: { schema: { kind: 'literal', value: 'UserId' } } },
  };
  const schema = { kind: 'intersection', schemas: [numberSchema, brandMarker] };

  assert.doesNotThrow(() => runtime.assertValue(schema, 42, context));
  assert.throws(() => runtime.assertValue(schema, '42', context), runtime.StrictTypeError);
});

test('branded primitives resolve object members declared through references', () => {
  const registry = new runtime.SchemaRegistry();
  registry.define('BrandMarker', {
    kind: 'object',
    properties: { __brand: { schema: { kind: 'literal', value: 'Id' } } },
  });
  const schema = {
    kind: 'intersection',
    schemas: [stringSchema, { kind: 'ref', name: 'BrandMarker' }],
  };

  assert.doesNotThrow(() => runtime.assertValue(schema, 'abc', { ...context, registry }));
  assert.throws(() => runtime.assertValue(schema, 1, { ...context, registry }), runtime.StrictTypeError);
});

test('object-only intersections still require every object property for real objects', () => {
  const schema = {
    kind: 'intersection',
    schemas: [
      { kind: 'object', properties: { a: { schema: stringSchema } } },
      { kind: 'object', properties: { b: { schema: numberSchema } } },
    ],
  };

  assert.doesNotThrow(() => runtime.assertValue(schema, { a: 'x', b: 1 }, context));
  assert.throws(
    () => runtime.assertValue(schema, { a: 'x' }, context),
    (error) => error instanceof runtime.StrictTypeError && error.code === 'REQUIRED_PROPERTY',
  );
});

test('mixed primitive and object intersections still require the object member for real objects', () => {
  const schema = {
    kind: 'intersection',
    schemas: [
      { kind: 'primitive', name: 'object' },
      { kind: 'object', properties: { __brand: { schema: { kind: 'literal', value: 'Id' } } } },
    ],
  };

  assert.doesNotThrow(() => runtime.assertValue(schema, { __brand: 'Id' }, context));
  assert.throws(
    () => runtime.assertValue(schema, {}, context),
    (error) => error instanceof runtime.StrictTypeError && error.code === 'REQUIRED_PROPERTY',
  );
});
