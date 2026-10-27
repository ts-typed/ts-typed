'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { AggregateStrictTypeError, ArrayAggregateStrictTypeError, StrictTypeError } = require('../../dist/runtime');

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

test('ArrayAggregateStrictTypeError is a StrictTypeError and a TypeError', () => {
  const elementError = new AggregateStrictTypeError([violation('dtos[0].name', 'string', 'number')]);
  const error = new ArrayAggregateStrictTypeError([elementError]);

  assert.ok(error instanceof ArrayAggregateStrictTypeError);
  assert.ok(error instanceof StrictTypeError);
  assert.ok(error instanceof TypeError);
  assert.equal(error.name, 'ArrayAggregateStrictTypeError');
});

test('rejects an empty errors array', () => {
  assert.throws(() => new ArrayAggregateStrictTypeError([]), /at least one/);
});

test('base StrictTypeError fields come from the first element error\'s first violation', () => {
  const first = new AggregateStrictTypeError([violation('dtos[0].name', 'string', 'number')]);
  const second = new AggregateStrictTypeError([violation('dtos[2].age', 'number', 'string')]);
  const error = new ArrayAggregateStrictTypeError([first, second]);

  assert.equal(error.propertyPath, 'dtos[0].name');
  assert.equal(error.expected, 'string');
  assert.equal(error.received, 'number');
});

test('errors holds one AggregateStrictTypeError per invalid element, in order, and message summarizes the element count', () => {
  const first = new AggregateStrictTypeError([violation('dtos[0].name', 'string', 'number')]);
  const second = new AggregateStrictTypeError([violation('dtos[2].age', 'number', 'string')]);
  const error = new ArrayAggregateStrictTypeError([first, second]);

  assert.equal(error.errors.length, 2);
  assert.equal(error.errors[0], first);
  assert.equal(error.errors[1], second);
  assert.equal(error.message, 'Validation failed: 2 invalid array element(s)');
});

test('toJSON nests each element error\'s own JSON under errors', () => {
  const first = new AggregateStrictTypeError([violation('dtos[0].name', 'string', 'number')]);
  const error = new ArrayAggregateStrictTypeError([first]);

  const json = error.toJSON();
  assert.equal(json.errors.length, 1);
  assert.deepEqual(json.errors[0], first.toJSON());
});

test('toJSON preserves each nested element error\'s elementIndex', () => {
  const first = new AggregateStrictTypeError([violation('dtos[0].name', 'string', 'number')], 0);
  const second = new AggregateStrictTypeError([violation('dtos[2].age', 'number', 'string')], 2);
  const error = new ArrayAggregateStrictTypeError([first, second]);

  const json = error.toJSON();
  assert.equal(json.errors[0].elementIndex, 0);
  assert.equal(json.errors[1].elementIndex, 2);
});
