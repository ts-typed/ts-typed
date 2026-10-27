'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const runtime = require('../../dist/runtime');

const stringSchema = { kind: 'primitive', name: 'string' };
const context = { contractKind: 'parameter', operation: 'argument', propertyPath: 'dto' };

test('TypeErrorResponse on a nested object property applies during the FIRST structural validation, not only on later field writes', () => {
  class Address {}
  runtime.TypeErrorResponse('CEP inválido', 422)(Address.prototype, 'zip');
  const addressSchema = {
    kind: 'object',
    properties: { zip: { schema: stringSchema } },
  };
  const userSchema = {
    kind: 'object',
    properties: { address: { schema: addressSchema } },
  };
  const user = { address: Object.assign(new Address(), { zip: 123 }) };

  assert.throws(
    () => runtime.assertValue(userSchema, user, context),
    (error) =>
      error instanceof runtime.StrictTypeError &&
      error.typeErrorResponseMessage === 'CEP inválido' &&
      error.typeErrorResponseStatus === 422,
  );
});

test('TypeErrorResponse on a decorated array field does not leak onto violations inside its own items', () => {
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
  const wrapper = Object.assign(new Wrapper(), {
    items: [Object.assign(new Item(), { name: 42 })],
  });

  assert.throws(
    () => runtime.assertValue(wrapperSchema, wrapper, context),
    (error) =>
      error instanceof runtime.StrictTypeError &&
      error.propertyPath === 'dto.items[0].name' &&
      error.typeErrorResponseMessage === undefined &&
      error.typeErrorResponseStatus === undefined,
  );
});

test('isServerPopulated is resolved for a nested ServerPopulated() entity reached during the FIRST structural validation', () => {
  class Meta {}
  runtime.ServerPopulated()(Meta);
  const metaSchema = {
    kind: 'object',
    properties: { code: { schema: stringSchema } },
  };
  const ownerSchema = {
    kind: 'object',
    properties: { meta: { schema: metaSchema } },
  };
  const owner = { meta: Object.assign(new Meta(), { code: 7 }) };

  assert.throws(
    () => runtime.assertValue(ownerSchema, owner, context),
    (error) => error instanceof runtime.StrictTypeError && error.isServerPopulated === true,
  );
});

test('ExtraProperties strip policy on a nested class instance is honored during the FIRST structural validation', () => {
  class Inner {}
  runtime.ExtraProperties('strip')(Inner);
  const innerSchema = {
    kind: 'object',
    properties: { a: { schema: stringSchema } },
  };
  const outerSchema = {
    kind: 'object',
    properties: { w: { schema: innerSchema } },
  };
  const inner = Object.assign(new Inner(), { a: 'ok', extra: 'to-be-stripped' });
  const value = { w: inner };

  assert.doesNotThrow(() => runtime.assertValue(outerSchema, value, context));
  assert.equal(Object.hasOwn(inner, 'extra'), false);
});
