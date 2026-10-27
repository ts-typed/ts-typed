'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { AggregateStrictTypeError, StrictTypeError } = require('../../dist/runtime');

function violation(propertyPath, expected, received) {
  return {
    code: 'TYPE_MISMATCH',
    contractKind: 'parameter',
    propertyPath,
    expected,
    received,
    operation: 'argument',
  };
}

test('AggregateStrictTypeError is a StrictTypeError and a TypeError', () => {
  const error = new AggregateStrictTypeError([violation('Dto.name', 'string', 'number')]);

  assert.ok(error instanceof AggregateStrictTypeError);
  assert.ok(error instanceof StrictTypeError);
  assert.ok(error instanceof TypeError);
  assert.equal(error.name, 'AggregateStrictTypeError');
});

test('base StrictTypeError fields come from the first violation, for backward-compatible single-error consumers', () => {
  const error = new AggregateStrictTypeError([
    violation('Dto.name', 'string', 'number'),
    violation('Dto.age', 'number', 'string'),
  ]);

  assert.equal(error.propertyPath, 'Dto.name');
  assert.equal(error.expected, 'string');
  assert.equal(error.received, 'number');
  assert.equal(error.code, 'TYPE_MISMATCH');
});

test('errors holds every violation, and message summarizes the count instead of only describing the first', () => {
  const violations = [violation('Dto.name', 'string', 'number'), violation('Dto.age', 'number', 'string')];
  const error = new AggregateStrictTypeError(violations);

  assert.deepEqual(error.errors, violations);
  assert.equal(error.message, 'Validation failed: 2 error(s)');
});

test('toJSON includes every violation alongside the base safe fields, with no raw value or stack', () => {
  const violations = [violation('Dto.name', 'string', 'number'), violation('Dto.age', 'number', 'string')];
  const json = new AggregateStrictTypeError(violations).toJSON();

  assert.deepEqual(json.errors, violations);
  assert.equal(json.propertyPath, 'Dto.name');
  assert.equal('stack' in json, false);
});

test('constructing with an empty list throws, since there is nothing to aggregate', () => {
  assert.throws(() => new AggregateStrictTypeError([]), /at least one violation/);
});

test('toJSON includes elementIndex when it was set (array-aggregation element error)', () => {
  const violations = [violation('name', 'string', 'number')];
  const json = new AggregateStrictTypeError(violations, 2).toJSON();

  assert.equal(json.elementIndex, 2);
});

test('toJSON omits elementIndex entirely (not present as undefined) when it was never set', () => {
  const violations = [violation('name', 'string', 'number')];
  const json = new AggregateStrictTypeError(violations).toJSON();

  assert.equal('elementIndex' in json, false);
});
