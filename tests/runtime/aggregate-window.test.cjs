'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  AggregateErrors,
  beginAggregateWindow,
  collectIfAggregating,
  setAggregateWindowLeakHandler,
  takeAggregateWindowViolations,
} = require('../../dist/runtime');

function violation(propertyPath) {
  return {
    code: 'TYPE_MISMATCH',
    contractKind: 'property',
    propertyPath,
    expected: 'string',
    received: 'number',
    operation: 'set',
  };
}

// GC-dependent tests need `node --test --expose-gc` to force a collection
// synchronously. When that flag isn't set, `global.gc` is undefined and
// those tests are skipped with a clear message rather than failing hard.
const gcAvailable = typeof global.gc === 'function';

function resetLeakHandlerToDefault() {
  // There is no exported "default" handler to restore, so tests that need a
  // known state install their own handler; this just gives every GC test a
  // fresh, inert handler so no test's assertions leak into another's.
  setAggregateWindowLeakHandler(() => {});
}

test('beginAggregateWindow is a no-op for an instance of an undecorated class — collectIfAggregating returns false', () => {
  class PlainDto {}
  const instance = new PlainDto();

  beginAggregateWindow(instance);

  assert.equal(collectIfAggregating(instance, violation('x')), false);
  assert.equal(takeAggregateWindowViolations(instance), undefined);
});

test('beginAggregateWindow opens a window for an instance of an @AggregateErrors() class — collectIfAggregating collects instead of signaling "not open"', () => {
  class Dto {}
  AggregateErrors()(Dto);
  const instance = new Dto();

  beginAggregateWindow(instance);

  assert.equal(collectIfAggregating(instance, violation('name')), true);
  assert.equal(collectIfAggregating(instance, violation('age')), true);
  // Close the window explicitly so nothing is left to report later.
  takeAggregateWindowViolations(instance);
});

test('takeAggregateWindowViolations closes the window and returns everything collected, in order', () => {
  class Dto {}
  AggregateErrors()(Dto);
  const instance = new Dto();
  beginAggregateWindow(instance);
  collectIfAggregating(instance, violation('name'));
  collectIfAggregating(instance, violation('age'));

  const violations = takeAggregateWindowViolations(instance);

  assert.deepEqual(violations.map((v) => v.propertyPath), ['name', 'age']);
  // Closed: a later write attempt is no longer collected.
  assert.equal(collectIfAggregating(instance, violation('email')), false);
});

test('takeAggregateWindowViolations on an instance whose window was never opened returns undefined (distinct from "opened but empty")', () => {
  class Dto {}
  AggregateErrors()(Dto);
  const instance = new Dto();
  // beginAggregateWindow was never called for this instance.

  assert.equal(takeAggregateWindowViolations(instance), undefined);
});

test('takeAggregateWindowViolations on a window opened but nothing collected returns an empty array, not undefined', () => {
  class Dto {}
  AggregateErrors()(Dto);
  const instance = new Dto();
  beginAggregateWindow(instance);

  assert.deepEqual(takeAggregateWindowViolations(instance), []);
});

test('two instances of the same decorated class have independent windows', () => {
  class Dto {}
  AggregateErrors()(Dto);
  const first = new Dto();
  const second = new Dto();
  beginAggregateWindow(first);
  beginAggregateWindow(second);

  collectIfAggregating(first, violation('name'));

  assert.deepEqual(takeAggregateWindowViolations(first).map((v) => v.propertyPath), ['name']);
  assert.deepEqual(takeAggregateWindowViolations(second), []);
});

test('takeAggregateWindowViolations after a prior take on the same instance returns undefined (double-take)', () => {
  class Dto {}
  AggregateErrors()(Dto);
  const instance = new Dto();
  beginAggregateWindow(instance);
  collectIfAggregating(instance, violation('name'));

  const first = takeAggregateWindowViolations(instance);
  const second = takeAggregateWindowViolations(instance);

  assert.deepEqual(first.map((v) => v.propertyPath), ['name']);
  assert.equal(second, undefined);
});

test('a real crossing (takeAggregateWindowViolations) survives an await gap after construction — no race with GC', async () => {
  class Dto {}
  AggregateErrors()(Dto);
  const instance = new Dto();
  beginAggregateWindow(instance);
  collectIfAggregating(instance, violation('name'));

  // Simulate the async gap between construction and a real parameter
  // crossing (e.g. NestJS's ValidationPipe awaiting `this.validate(...)`
  // between `plainToInstance` and the controller method call).
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();

  const violations = takeAggregateWindowViolations(instance);
  assert.deepEqual(violations.map((v) => v.propertyPath), ['name']);
});

test('setAggregateWindowLeakHandler is invoked with buffered violations when a window closed by GC still held unread violations', { skip: !gcAvailable && 'requires node --test --expose-gc' }, async () => {
  let received;
  setAggregateWindowLeakHandler((violations) => {
    received = violations;
  });

  (function openAndDrop() {
    class Dto {}
    AggregateErrors()(Dto);
    let instance = new Dto();
    beginAggregateWindow(instance);
    collectIfAggregating(instance, violation('name'));
    // Drop the only reference to `instance` by letting it go out of scope.
    instance = undefined;
  })();

  global.gc();
  // FinalizationRegistry callbacks run on a microtask after GC, not
  // synchronously inside gc() — give them a turn to fire.
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(received, 'leak handler was never called');
  assert.deepEqual(received.map((v) => v.propertyPath), ['name']);

  resetLeakHandlerToDefault();
});

test('a window closed by a real crossing does NOT later also trigger the leak handler', { skip: !gcAvailable && 'requires node --test --expose-gc' }, async () => {
  // A canary: an instance that is NEVER closed, dropped alongside the
  // properly-closed one. Without this, a leak handler that never fires for
  // either instance would make this test pass vacuously (GC simply never
  // ran, or the FinalizationRegistry callback never fired at all) --
  // proving nothing about the distinction this test exists to check. The
  // canary firing is what proves GC actually ran and the finalizer path
  // actually works, so a silent 0-calls result for the properly-closed
  // instance is a real pass, not a false one.
  const leaked = [];
  setAggregateWindowLeakHandler((violations) => {
    leaked.push(violations);
  });

  (function openCloseAndDrop() {
    class Dto {}
    AggregateErrors()(Dto);

    let properlyClosed = new Dto();
    beginAggregateWindow(properlyClosed);
    collectIfAggregating(properlyClosed, violation('name'));
    // Real crossing closes the window and unregisters the finalizer.
    takeAggregateWindowViolations(properlyClosed);
    properlyClosed = undefined;

    // The canary: constructed and dropped the same way, but never closed --
    // it SHOULD leak. Its firing is what proves GC actually ran.
    let shouldLeak = new Dto();
    beginAggregateWindow(shouldLeak);
    collectIfAggregating(shouldLeak, violation('age'));
    shouldLeak = undefined;
  })();

  global.gc();
  await new Promise((resolve) => setImmediate(resolve));

  // The canary (unclosed instance) must have leaked -- this proves GC
  // actually ran and the finalizer path actually fires -- while the
  // properly-closed instance must NOT have, which is the real assertion
  // this test exists to make.
  assert.equal(leaked.length, 1, 'the canary (unclosed) instance never triggered the leak handler -- GC may not have run');
  assert.deepEqual(leaked[0].map((v) => v.propertyPath), ['age']);

  resetLeakHandlerToDefault();
});
