'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const {
  AggregateErrors,
  AggregateStrictTypeError,
  beginAggregateWindow,
  collectIfAggregating,
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
  // Close the window explicitly; otherwise its auto-close microtask would throw
  // AggregateStrictTypeError for the two buffered violations after this test.
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

test('a window nobody closes auto-closes on the next microtask, with zero violations collected — no throw', async () => {
  class Dto {}
  AggregateErrors()(Dto);
  const instance = new Dto();
  beginAggregateWindow(instance);

  await new Promise((resolve) => queueMicrotask(resolve));

  // The window already closed itself; a later write is fail-fast (not collected).
  assert.equal(collectIfAggregating(instance, violation('name')), false);
});

test('a window nobody closes auto-closes on the next microtask and throws AggregateStrictTypeError asynchronously when violations were buffered', () => {
  // The async throw is an uncaughtException, which the node test runner itself
  // handles and would mark this file failed. Run the scenario in a child process
  // with its own uncaughtException handler and assert on what it reports.
  const script = `
    const {
      AggregateErrors, AggregateStrictTypeError, beginAggregateWindow, collectIfAggregating,
    } = require(${JSON.stringify(require.resolve('../../dist/runtime'))});
    class Dto {}
    AggregateErrors()(Dto);
    const instance = new Dto();
    beginAggregateWindow(instance);
    const v = (propertyPath) => ({ code: 'TYPE_MISMATCH', contractKind: 'property', propertyPath, expected: 'string', received: 'number', operation: 'set' });
    collectIfAggregating(instance, v('name'));
    collectIfAggregating(instance, v('age'));
    process.on('uncaughtException', (err) => {
      console.log(JSON.stringify({ isAggregate: err instanceof AggregateStrictTypeError, paths: err.errors.map((e) => e.propertyPath) }));
    });
  `;
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out.trim()), { isAggregate: true, paths: ['name', 'age'] });
});

test('a real parameter crossing before the microtask fires wins the race — the microtask finds the window already closed and does nothing', async () => {
  class Dto {}
  AggregateErrors()(Dto);
  const instance = new Dto();
  beginAggregateWindow(instance);
  collectIfAggregating(instance, violation('name'));

  // Simulates protectValue's real close happening synchronously, before the microtask queue drains.
  const violations = takeAggregateWindowViolations(instance);
  assert.deepEqual(violations.map((v) => v.propertyPath), ['name']);

  let uncaught;
  const onUncaught = (err) => { uncaught = err; };
  process.once('uncaughtException', onUncaught);
  try {
    await new Promise((resolve) => queueMicrotask(resolve));
    await new Promise((resolve) => queueMicrotask(resolve));
  } finally {
    process.removeListener('uncaughtException', onUncaught);
  }

  assert.equal(uncaught, undefined);
});
