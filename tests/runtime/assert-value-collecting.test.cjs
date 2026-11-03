'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  AggregateErrors,
  assertValue,
  assertValueCollecting,
  beginAggregateWindow,
  collectIfAggregating,
  StrictTypeError,
  takeAggregateWindowViolations,
} = require('../../dist/runtime');

const stringSchema = { kind: 'primitive', name: 'string' };
const numberSchema = { kind: 'primitive', name: 'number' };

const context = {
  contractKind: 'parameter',
  operation: 'argument',
  propertyPath: 'CreateUserDto',
};

test('assertValueCollecting returns every violation in a flat object instead of stopping at the first', () => {
  const schema = {
    kind: 'object',
    properties: {
      name: { schema: stringSchema },
      age: { schema: numberSchema },
    },
  };
  const violations = assertValueCollecting(schema, { name: 42, age: 'old' }, context);

  assert.equal(violations.length, 2);
  assert.deepEqual(
    violations.map((v) => v.propertyPath).sort(),
    ['CreateUserDto.age', 'CreateUserDto.name'],
  );
  assert.ok(violations.every((v) => v.code === 'TYPE_MISMATCH'));
});

test('assertValueCollecting returns an empty array for a fully valid value', () => {
  const schema = { kind: 'object', properties: { name: { schema: stringSchema } } };
  assert.deepEqual(assertValueCollecting(schema, { name: 'Ada' }, context), []);
});

test('assertValueCollecting walks nested objects to full depth, collecting violations at every level', () => {
  const schema = {
    kind: 'object',
    properties: {
      name: { schema: stringSchema },
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
  const violations = assertValueCollecting(
    schema,
    { name: 42, profile: { bio: 7, age: 'old' } },
    context,
  );

  assert.equal(violations.length, 3);
  assert.deepEqual(
    violations.map((v) => v.propertyPath).sort(),
    ['CreateUserDto.name', 'CreateUserDto.profile.age', 'CreateUserDto.profile.bio'],
  );
});

test('assertValueCollecting walks every object in an array of objects', () => {
  const schema = {
    kind: 'array',
    items: { kind: 'object', properties: { name: { schema: stringSchema } } },
  };
  const violations = assertValueCollecting(schema, [{ name: 'Ada' }, { name: 1 }, { name: 2 }], context);

  assert.deepEqual(
    violations.map((v) => v.propertyPath),
    ['CreateUserDto[1].name', 'CreateUserDto[2].name'],
  );
});

test('assertValueCollecting mixes REQUIRED_PROPERTY and EXTRA_PROPERTY with TYPE_MISMATCH in one pass', () => {
  const schema = {
    kind: 'object',
    properties: {
      name: { schema: stringSchema },
      age: { schema: numberSchema },
    },
  };
  const violations = assertValueCollecting(schema, { age: 'old', extra: true }, context);

  assert.deepEqual(violations.map((v) => v.code).sort(), ['EXTRA_PROPERTY', 'REQUIRED_PROPERTY', 'TYPE_MISMATCH']);
});

test('assertValueCollecting does not leak a union field candidate probing into the collected list', () => {
  const schema = {
    kind: 'object',
    properties: { value: { schema: { kind: 'union', schemas: [stringSchema, numberSchema] } } },
  };
  const violations = assertValueCollecting(schema, { value: true }, context);

  assert.equal(violations.length, 1);
  assert.equal(violations[0].expected, 'union');
});

test('a rejected union violation reports why each member was rejected, instead of just "union"', () => {
  const schema = {
    kind: 'object',
    properties: { value: { schema: { kind: 'union', schemas: [stringSchema, numberSchema] } } },
  };
  const violations = assertValueCollecting(schema, { value: true }, context);

  assert.equal(violations.length, 1);
  const [violation] = violations;
  assert.equal(violation.candidates.length, 2);
  assert.deepEqual(
    violation.candidates.map((candidate) => candidate.expected).sort(),
    ['number', 'string'],
  );
  assert.ok(violation.candidates.every((candidate) => candidate.propertyPath === 'CreateUserDto.value'));
});

test('the per-candidate breakdown is also attached to the thrown StrictTypeError in fail-fast mode', () => {
  const schema = { kind: 'union', schemas: [stringSchema, numberSchema] };

  assert.throws(
    () => assertValue(schema, true, context),
    (error) =>
      error instanceof StrictTypeError &&
      error.expected === 'union' &&
      error.candidates.length === 2 &&
      error.candidates.every((candidate) => candidate.expected === 'string' || candidate.expected === 'number'),
  );
});

test('assertValue (non-collecting) still throws on the very first violation, unchanged', () => {
  const schema = {
    kind: 'object',
    properties: {
      name: { schema: stringSchema },
      age: { schema: numberSchema },
    },
  };
  assert.throws(
    () => assertValue(schema, { name: 42, age: 'old' }, context),
    (error) => error instanceof StrictTypeError && error.propertyPath === 'CreateUserDto.name',
  );
});

test('assertValueCollecting walks into an optional nested DTO instead of reporting one opaque "union" violation', () => {
  const profileSchema = {
    kind: 'object',
    properties: {
      bio: { schema: stringSchema },
      age: { schema: numberSchema },
    },
  };
  const schema = {
    kind: 'object',
    properties: {
      profile: {
        schema: { kind: 'union', schemas: [profileSchema, { kind: 'primitive', name: 'undefined' }] },
        optional: true,
      },
    },
  };
  const violations = assertValueCollecting(schema, { profile: { bio: 7, age: 'old' } }, context);

  assert.equal(violations.length, 2);
  assert.deepEqual(
    violations.map((v) => v.propertyPath).sort(),
    ['CreateUserDto.profile.age', 'CreateUserDto.profile.bio'],
  );
});

test('assertValueCollecting still reports a plain "union" violation when the value matches zero or several members ambiguously', () => {
  const schema = {
    kind: 'object',
    properties: {
      value: { schema: { kind: 'union', schemas: [stringSchema, numberSchema] } },
    },
  };
  const violations = assertValueCollecting(schema, { value: true }, context);

  assert.equal(violations.length, 1);
  assert.equal(violations[0].expected, 'union');
});

test('assertValueCollecting falls back to one "union" violation when a plain object matches two object-shaped members', () => {
  const bioProfileSchema = {
    kind: 'object',
    properties: { bio: { schema: stringSchema } },
  };
  const ageProfileSchema = {
    kind: 'object',
    properties: { age: { schema: numberSchema } },
  };
  const schema = {
    kind: 'object',
    properties: {
      profile: { schema: { kind: 'union', schemas: [bioProfileSchema, ageProfileSchema] } },
    },
  };
  // A plain object reaches selectSoleStructuralMatch's filter step and matches
  // both object-shaped members (two matches, so it returns undefined), and it
  // fails both, so the single opaque "union" fallback must be reported.
  const violations = assertValueCollecting(schema, { profile: {} }, context);

  assert.equal(violations.length, 1);
  assert.equal(violations[0].expected, 'union');
});

test('assertValueCollecting does not force a valid Date through the lone object-shaped union candidate', () => {
  const profileSchema = {
    kind: 'object',
    properties: { bio: { schema: stringSchema } },
  };
  const schema = {
    kind: 'object',
    properties: {
      value: { schema: { kind: 'union', schemas: [{ kind: 'date' }, profileSchema] } },
    },
  };
  const violations = assertValueCollecting(schema, { value: new Date('2024-01-01') }, context);

  assert.deepEqual(violations, []);
});

test('assertValueCollecting does not force a valid tuple through the array-shaped union candidate', () => {
  const tupleSchema = { kind: 'tuple', items: [numberSchema, numberSchema] };
  const arraySchema = { kind: 'array', items: stringSchema };
  const schema = {
    kind: 'object',
    properties: {
      value: { schema: { kind: 'union', schemas: [tupleSchema, arraySchema] } },
    },
  };
  const violations = assertValueCollecting(schema, { value: [1, 2] }, context);

  assert.deepEqual(violations, []);
});

test('non-collecting (fail-fast) union validation is unaffected by the new collecting-mode branch', () => {
  const profileSchema = {
    kind: 'object',
    properties: { bio: { schema: stringSchema } },
  };
  const schema = { kind: 'union', schemas: [profileSchema, { kind: 'primitive', name: 'undefined' }] };

  assert.throws(
    () => assertValue(schema, { bio: 7 }, context),
    (error) => error.propertyPath === context.propertyPath && error.expected === 'union',
  );
});

test('assertValueCollecting drains a nested instance\'s open aggregate window and merges it with the structural pass, instead of silently accepting its stale default value', () => {
  class Profile {
    constructor() {
      this.bio = '';
    }
  }
  AggregateErrors()(Profile);
  const profile = new Profile();
  beginAggregateWindow(profile);
  collectIfAggregating(profile, {
    code: 'TYPE_MISMATCH',
    contractKind: 'property',
    propertyPath: 'Profile.bio',
    expected: 'string',
    received: 'number',
    operation: 'set',
  });

  const schema = {
    kind: 'object',
    properties: {
      name: { schema: stringSchema },
      profile: { schema: { kind: 'object', properties: { bio: { schema: stringSchema } } } },
    },
  };
  const violations = assertValueCollecting(schema, { name: 'Ada', profile }, context);

  assert.equal(violations.length, 1);
  assert.equal(violations[0].propertyPath, 'Profile.bio');
});

test('assertValue (fail-fast) also drains and throws for a nested instance with an open aggregate window, instead of accepting it', () => {
  class Profile {
    constructor() {
      this.bio = '';
    }
  }
  AggregateErrors()(Profile);
  const profile = new Profile();
  beginAggregateWindow(profile);
  collectIfAggregating(profile, {
    code: 'TYPE_MISMATCH',
    contractKind: 'property',
    propertyPath: 'Profile.bio',
    expected: 'string',
    received: 'number',
    operation: 'set',
  });

  const schema = {
    kind: 'object',
    properties: { profile: { schema: { kind: 'object', properties: { bio: { schema: stringSchema } } } } },
  };

  assert.throws(
    () => assertValue(schema, { profile }, context),
    (error) => error instanceof StrictTypeError && error.propertyPath === 'Profile.bio',
  );
});

test('a reference value that never had a window opened is completely unaffected by the drain check', () => {
  const schema = { kind: 'object', properties: { bio: { schema: stringSchema } } };
  assert.deepEqual(assertValueCollecting(schema, { bio: 'ok' }, context), []);
  assert.doesNotThrow(() => assertValue(schema, { bio: 'ok' }, context));
});

test('an unknown contract does not close an aggregate window before a structural boundary reaches the instance', () => {
  class Profile {}
  AggregateErrors()(Profile);
  const profile = new Profile();
  beginAggregateWindow(profile);
  collectIfAggregating(profile, {
    code: 'TYPE_MISMATCH',
    contractKind: 'property',
    propertyPath: 'Profile.bio',
    expected: 'string',
    received: 'number',
    operation: 'set',
  });

  assertValue({ kind: 'unknown' }, profile, context);

  assert.equal(takeAggregateWindowViolations(profile).length, 1);
});
