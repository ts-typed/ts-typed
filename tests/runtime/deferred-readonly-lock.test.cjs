'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  installFieldGuard,
  lockReadonlyField,
  withDeferredReadonlyLock,
  StrictTypeError,
} = require('../../dist/runtime');

const numberSchema = { kind: 'primitive', name: 'number' };

function context(overrides = {}) {
  return { contractKind: 'property', operation: 'initialize', propertyPath: 'value', ...overrides };
}

test('a lock requested inside withDeferredReadonlyLock is deferred: the field stays writable until the call settles', () => {
  const instance = {};
  installFieldGuard(instance, 'value', numberSchema, context(), { initialized: false, readonlyField: true });
  instance.value = 1;

  withDeferredReadonlyLock(() => {
    lockReadonlyField(instance, 'value');
    // Still inside the deferred call: the lock must not have applied yet.
    instance.value = 2;
    assert.equal(instance.value, 2);
  });

  // The call has settled: the deferred lock now applies.
  assert.throws(() => {
    instance.value = 3;
  }, (error) => error instanceof StrictTypeError && error.code === 'READONLY_PROPERTY');
  assert.equal(instance.value, 2);
});

test('withDeferredReadonlyLock returns the wrapped function\'s own return value', () => {
  const result = withDeferredReadonlyLock(() => 'the-transform-result');
  assert.equal(result, 'the-transform-result');
});

test('withDeferredReadonlyLock resolves and applies deferred locks for an async wrapped function', async () => {
  const instance = {};
  installFieldGuard(instance, 'value', numberSchema, context(), { initialized: false, readonlyField: true });
  instance.value = 1;

  const result = await withDeferredReadonlyLock(async () => {
    lockReadonlyField(instance, 'value');
    await new Promise((resolve) => setImmediate(resolve));
    instance.value = 2;
    return 'async-result';
  });

  assert.equal(result, 'async-result');
  assert.throws(() => {
    instance.value = 3;
  }, (error) => error instanceof StrictTypeError && error.code === 'READONLY_PROPERTY');
});

test('nested withDeferredReadonlyLock calls only apply the lock once the OUTERMOST call settles', () => {
  const instance = {};
  installFieldGuard(instance, 'value', numberSchema, context(), { initialized: false, readonlyField: true });
  instance.value = 1;

  withDeferredReadonlyLock(() => {
    withDeferredReadonlyLock(() => {
      lockReadonlyField(instance, 'value');
      instance.value = 2;
    });
    // Inner call settled, but the outer call is still open: still writable.
    instance.value = 3;
    assert.equal(instance.value, 3);
  });

  assert.throws(() => {
    instance.value = 4;
  }, (error) => error instanceof StrictTypeError && error.code === 'READONLY_PROPERTY');
  assert.equal(instance.value, 3);
});

test('a synchronous throw inside withDeferredReadonlyLock still settles and applies the deferred lock', () => {
  const instance = {};
  installFieldGuard(instance, 'value', numberSchema, context(), { initialized: false, readonlyField: true });
  instance.value = 1;

  assert.throws(() => {
    withDeferredReadonlyLock(() => {
      lockReadonlyField(instance, 'value');
      throw new Error('transform blew up');
    });
  }, /transform blew up/);

  // The lock must still have been applied despite the throw — otherwise a
  // failing ValidationPipe.transform() would silently leave the field
  // unlocked for the rest of the process.
  assert.throws(() => {
    instance.value = 2;
  }, (error) => error instanceof StrictTypeError && error.code === 'READONLY_PROPERTY');
});

test('an async rejection inside withDeferredReadonlyLock still settles and applies the deferred lock', async () => {
  const instance = {};
  installFieldGuard(instance, 'value', numberSchema, context(), { initialized: false, readonlyField: true });
  instance.value = 1;

  await assert.rejects(
    withDeferredReadonlyLock(async () => {
      lockReadonlyField(instance, 'value');
      await new Promise((resolve) => setImmediate(resolve));
      throw new Error('async transform blew up');
    }),
    /async transform blew up/,
  );

  assert.throws(() => {
    instance.value = 2;
  }, (error) => error instanceof StrictTypeError && error.code === 'READONLY_PROPERTY');
});

test('lockReadonlyField called OUTSIDE any withDeferredReadonlyLock call still locks immediately, unaffected by the deferral mechanism', () => {
  const instance = {};
  installFieldGuard(instance, 'value', numberSchema, context(), { initialized: false, readonlyField: true });
  instance.value = 1;
  lockReadonlyField(instance, 'value');

  assert.throws(() => {
    instance.value = 2;
  }, (error) => error instanceof StrictTypeError && error.code === 'READONLY_PROPERTY');
});

test('a field never locked during a withDeferredReadonlyLock call is simply not in the pending queue: unrelated locked fields are unaffected', () => {
  const locked = {};
  const untouched = {};
  installFieldGuard(locked, 'value', numberSchema, context(), { initialized: false, readonlyField: true });
  installFieldGuard(untouched, 'value', numberSchema, context(), { initialized: false, readonlyField: true });
  locked.value = 1;
  untouched.value = 1;

  withDeferredReadonlyLock(() => {
    lockReadonlyField(locked, 'value');
  });

  assert.throws(() => {
    locked.value = 2;
  }, (error) => error instanceof StrictTypeError && error.code === 'READONLY_PROPERTY');
  // Never locked at all: still writable.
  untouched.value = 2;
  assert.equal(untouched.value, 2);
});
