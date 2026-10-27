'use strict';

/**
 * Standalone runtime overhead benchmark for the instrumented protection
 * layer (not the build pipeline). Not part of the published package and not
 * run by `npm test`; it exists so the overhead documented in
 * docs/performance.md can be reproduced and re-measured after future
 * changes to system/base/src/runtime/**.
 *
 * Usage: node benchmarks/runtime-benchmark.cjs   (run after `npm run build`)
 */

const { assertValue, protectValue, installFieldGuard, SchemaRegistry } = require('../dist/runtime');

const ITERATIONS = 2_000_000;
const WARMUP = 50_000;

function context(overrides = {}) {
  return { contractKind: 'variable', operation: 'assert', propertyPath: 'value', ...overrides };
}

function time(label, iterations, fn) {
  for (let i = 0; i < WARMUP; i += 1) fn(i);
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) fn(i);
  const end = process.hrtime.bigint();
  const totalMs = Number(end - start) / 1e6;
  const perOpNs = (Number(end - start) / iterations);
  console.log(`${label.padEnd(52)} ${totalMs.toFixed(1).padStart(9)}ms total  ${perOpNs.toFixed(1).padStart(8)}ns/op`);
  return perOpNs;
}

function forceGc() {
  if (global.gc) global.gc();
}

function heapUsedMb() {
  return process.memoryUsage().heapUsed / (1024 * 1024);
}

console.log('--- CPU overhead (lower is better; compare "plain" vs "protected" rows) ---\n');

// 1. Primitive assertion.
const numberSchema = { kind: 'primitive', name: 'number' };
let sinkNumber = 0;
const plainNumberNs = time('plain: assign a number', ITERATIONS, (i) => {
  sinkNumber = i;
});
const assertedNumberNs = time('assertValue: validate a number', ITERATIONS, (i) => {
  assertValue(numberSchema, i, context());
  sinkNumber = i;
});

// 2. Small structural object (3 fields).
const objectSchema = {
  kind: 'object',
  properties: {
    name: { schema: { kind: 'primitive', name: 'string' } },
    age: { schema: { kind: 'primitive', name: 'number' } },
    active: { schema: { kind: 'primitive', name: 'boolean' } },
  },
};
const sampleObject = { name: 'Ada', age: 30, active: true };
let sinkObject;
time('plain: reference a 3-field object', ITERATIONS, () => {
  sinkObject = sampleObject;
});
const assertedObjectNs = time('assertValue: validate a 3-field object', ITERATIONS, () => {
  assertValue(objectSchema, sampleObject, context());
  sinkObject = sampleObject;
});

// 3. protectValue on a fresh object each call (closer to a real `initialize`
// at a variable/property boundary, including the deep-protection install
// pass for nested containers).
const registry = new SchemaRegistry();
const protectIterations = 200_000;
time('plain: allocate + reference a 3-field object', protectIterations, (i) => {
  sinkObject = { name: 'Ada', age: i, active: true };
});
time('protectValue: validate + install deep protection', protectIterations, (i) => {
  sinkObject = protectValue(objectSchema, { name: 'Ada', age: i, active: true }, context({ registry }));
});

// 4. Class field guard: install cost (once per instance) vs steady-state
// write cost (every mutation, the realistic hot path).
class PlainBox {
  constructor(value) {
    this.value = value;
  }
}
const installIterations = 200_000;
time('plain: construct an instance (no guard)', installIterations, (i) => {
  sinkObject = new PlainBox(i);
});
time('installFieldGuard: construct + install guard (once per instance)', installIterations, (i) => {
  const instance = {};
  installFieldGuard(
    instance,
    'value',
    numberSchema,
    context({ contractKind: 'property', operation: 'initialize', registry }),
    { initialized: false },
  );
  instance.value = i;
  sinkObject = instance;
});

const guardedInstance = {};
installFieldGuard(
  guardedInstance,
  'value',
  numberSchema,
  context({ contractKind: 'property', operation: 'initialize', registry }),
  { initialized: false },
);
guardedInstance.value = 0;
const plainInstance = { value: 0 };
time('plain: write to an already-plain field (steady state)', ITERATIONS, (i) => {
  plainInstance.value = i;
});
const writeGuardedNs = time('guarded field: write through installed accessor (steady state)', ITERATIONS, (i) => {
  guardedInstance.value = i;
});

console.log('\n--- Memory overhead per guarded instance (requires --expose-gc for stable numbers) ---\n');

const instanceCount = 200_000;
forceGc();
const beforePlain = heapUsedMb();
const plainInstances = [];
for (let i = 0; i < instanceCount; i += 1) {
  plainInstances.push({ value: i });
}
forceGc();
const afterPlain = heapUsedMb();
console.log(`${instanceCount} plain objects: ${(afterPlain - beforePlain).toFixed(2)}MB (${(((afterPlain - beforePlain) * 1024 * 1024) / instanceCount).toFixed(0)} bytes/instance)`);

forceGc();
const beforeGuarded = heapUsedMb();
const guardedInstances = [];
for (let i = 0; i < instanceCount; i += 1) {
  const instance = {};
  installFieldGuard(
    instance,
    'value',
    numberSchema,
    context({ contractKind: 'property', operation: 'initialize', registry }),
    { initialized: false },
  );
  instance.value = i;
  guardedInstances.push(instance);
}
forceGc();
const afterGuarded = heapUsedMb();
console.log(`${instanceCount} guarded objects: ${(afterGuarded - beforeGuarded).toFixed(2)}MB (${(((afterGuarded - beforeGuarded) * 1024 * 1024) / instanceCount).toFixed(0)} bytes/instance)`);

console.log('\n--- Summary ratios ---\n');
console.log(`assertValue(number) is ${(assertedNumberNs / plainNumberNs).toFixed(1)}x a bare assignment`);
console.log(`assertValue(3-field object) is ${(assertedObjectNs / plainNumberNs).toFixed(1)}x a bare assignment`);
console.log(`steady-state guarded write is ${(writeGuardedNs / plainNumberNs).toFixed(1)}x a bare assignment`);
console.log(`plainInstances/guardedInstances kept alive: ${plainInstances.length}/${guardedInstances.length} (prevents dead-code elimination of the loops above)`);
void sinkNumber;
void sinkObject;

console.log('\n--- AggregateErrors overhead ---\n');

const { AggregateErrors, beginAggregateWindow } = require('../dist/runtime');

class BenchDto {}
AggregateErrors()(BenchDto);
// Hoisted out of the timed loop so the "plain" row measures instance
// construction, not class creation.
class Plain {}

const constructionIterations = 500_000;
time('plain: construct an undecorated instance', constructionIterations, () => {
  // eslint-disable-next-line no-new
  new Plain();
});
time('construct + beginAggregateWindow (schedules 1 microtask)', constructionIterations, () => {
  const instance = new BenchDto();
  beginAggregateWindow(instance);
});

console.log('\n--- Array-of-DTO aggregation overhead ---\n');

class AggDto {
  name;
  age;
}
AggregateErrors()(AggDto);
const dtoSchema = {
  kind: 'object',
  aggregateErrors: true,
  properties: {
    name: { schema: { kind: 'primitive', name: 'string' } },
    age: { schema: { kind: 'primitive', name: 'number' } },
  },
};
const arraySchema = { kind: 'array', items: dtoSchema };
const arrayContext = { contractKind: 'parameter', operation: 'argument', propertyPath: 'dtos' };

function makeValidArray(size) {
  const arr = [];
  for (let i = 0; i < size; i += 1) {
    const dto = new AggDto();
    dto.name = `name-${i}`;
    dto.age = i;
    arr.push(dto);
  }
  return arr;
}

const arrayIterations = 20_000;
const smallValidArray = makeValidArray(5);
const largeValidArray = makeValidArray(200);

time('protectValue: array of 5 valid decorated DTOs', arrayIterations, () => {
  protectValue(arraySchema, smallValidArray, arrayContext);
});
time('protectValue: array of 200 valid decorated DTOs', arrayIterations / 10, () => {
  protectValue(arraySchema, largeValidArray, arrayContext);
});

const allInvalidArray = makeValidArray(200).map((dto) => {
  dto.name = 42; // every element now invalid
  return dto;
});
time('protectValue: array of 200 decorated DTOs, ALL invalid (worst case — no early exit)', arrayIterations / 10, () => {
  try {
    protectValue(arraySchema, allInvalidArray, arrayContext);
  } catch {
    // expected on every iteration — measuring the full-walk cost
  }
});
