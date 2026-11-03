'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { analyzeProject } = require('../../../dist/compiler/analysis');
const { createContractTransformer } = require('../../../dist/compiler/transform');

const runtimeModule = join(__dirname, '../../../dist/runtime');

function emit(source) {
  const root = mkdtempSync(join(tmpdir(), 'ts-typed-ranged-'));
  const sourceRoot = join(root, 'src');
  const declarations = join(root, 'node_modules', 'ts-typed');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(declarations, { recursive: true });
  writeFileSync(
    join(declarations, 'index.d.ts'),
    [
      'export class StrictTypeError extends TypeError {}',
      'declare const ttRangedBrand: unique symbol;',
      "export type Int<Min extends number = number, Max extends number = number> = number & { readonly [ttRangedBrand]?: { readonly kind: 'int'; readonly bounds: readonly [Min, Max] } };",
      "export type Float<Min extends number = number, Max extends number = number> = number & { readonly [ttRangedBrand]?: { readonly kind: 'float'; readonly bounds: readonly [Min, Max] } };",
      "export type Str<MinLen extends number = number, MaxLen extends number = number> = string & { readonly [ttRangedBrand]?: { readonly kind: 'str'; readonly bounds: readonly [MinLen, MaxLen] } };",
    ].join('\n'),
  );
  writeFileSync(join(sourceRoot, 'globals.d.ts'), 'declare const process: { stdout: { write(chunk: string): boolean } };\n');
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', module: 'CommonJS', moduleResolution: 'Node', rootDir: './src', outDir: './out', skipLibCheck: true },
    include: ['src/**/*.ts'],
  }));
  writeFileSync(join(sourceRoot, 'main.ts'), source);
  const analysis = analyzeProject({ tsconfigPath: join(root, 'tsconfig.json') });
  assert.equal(analysis.tsDiagnostics.length, 0, analysis.tsDiagnostics.map((item) => item.messageText).join('\n'));
  const diagnostics = [];
  const emitted = analysis.program.emit(undefined, undefined, undefined, false, {
    before: [createContractTransformer({ analysis, runtimeModule, onDiagnostic: (item) => diagnostics.push(item) })],
  });
  assert.equal(emitted.emitSkipped, false);
  return { root, diagnostics, analysisDiagnostics: analysis.diagnostics };
}

function run(project) {
  return spawnSync(process.execPath, [join(project.root, 'out', 'main.js')], { cwd: project.root, encoding: 'utf8' });
}

test('Int<Min,Max> validates both bounds at a function parameter boundary, no decorator', () => {
  const project = emit([
    "import type { Int } from 'ts-typed';",
    'function setAge(age: Int<0, 150>): number { return age; }',
    'function accepts(value: number): boolean { try { setAge(value); return true; } catch { return false; } }',
    'process.stdout.write(JSON.stringify({',
    '  valid: accepts(42),',
    '  tooHigh: accepts(151),',
    '  negative: accepts(-1),',
    '  notInteger: accepts(1.5),',
    '}));',
  ].join('\n'));

  const result = run(project);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    valid: true,
    tooHigh: false,
    negative: false,
    notInteger: false,
  });
});

test('Int<Min> (min only) and Int<number,Max> (max only) each check a single independent bound', () => {
  const project = emit([
    "import type { Int } from 'ts-typed';",
    'function min(value: Int<0>): number { return value; }',
    'function max(value: Int<number, 10>): number { return value; }',
    'const results = {',
    '  minAcceptsLarge: (() => { try { min(1_000_000); return true; } catch { return false; } })(),',
    '  minRejectsNegative: (() => { try { min(-1); return true; } catch { return false; } })(),',
    '  maxAcceptsZero: (() => { try { max(0); return true; } catch { return false; } })(),',
    '  maxRejectsAboveTen: (() => { try { max(11); return true; } catch { return false; } })(),',
    '};',
    'process.stdout.write(JSON.stringify(results));',
  ].join('\n'));

  const result = run(project);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    minAcceptsLarge: true,
    minRejectsNegative: false,
    maxAcceptsZero: true,
    maxRejectsAboveTen: false,
  });
});

test('Float<Min,Max> accepts non-integers within range and rejects NaN/Infinity', () => {
  const project = emit([
    "import type { Float } from 'ts-typed';",
    'function price(value: Float<0, 100>): number { return value; }',
    'const results = {',
    '  decimalInRange: (() => { try { price(12.5); return true; } catch { return false; } })(),',
    '  nanRejected: (() => { try { price(NaN); return true; } catch { return false; } })(),',
    '  infinityRejected: (() => { try { price(Infinity); return true; } catch { return false; } })(),',
    '};',
    'process.stdout.write(JSON.stringify(results));',
  ].join('\n'));

  const result = run(project);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    decimalInRange: true,
    nanRejected: false,
    infinityRejected: false,
  });
});

test('Str<MinLen,MaxLen> validates string length at a class field boundary', () => {
  const project = emit([
    "import type { Str } from 'ts-typed';",
    'interface SignupDto { nickname: Str<1, 20>; }',
    'function accept(dto: SignupDto): string { return dto.nickname; }',
    'const results = {',
    '  withinRange: (() => { try { accept({ nickname: "ada" }); return true; } catch { return false; } })(),',
    '  tooLong: (() => { try { accept({ nickname: "x".repeat(21) }); return true; } catch { return false; } })(),',
    '  empty: (() => { try { accept({ nickname: "" }); return true; } catch { return false; } })(),',
    '};',
    'process.stdout.write(JSON.stringify(results));',
  ].join('\n'));

  const result = run(project);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    withinRange: true,
    tooLong: false,
    empty: false,
  });
});

test('a consumer alias over Int<Min,Max> keeps the bounds (type Age = Int<0,150>)', () => {
  const project = emit([
    "import type { Int } from 'ts-typed';",
    'type Age = Int<0, 150>;',
    'function setAge(age: Age): number { return age; }',
    'const results = {',
    '  accepted: (() => { try { setAge(30); return true; } catch { return false; } })(),',
    '  rejected: (() => { try { setAge(200); return true; } catch { return false; } })(),',
    '};',
    'process.stdout.write(JSON.stringify(results));',
  ].join('\n'));

  const result = run(project);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { accepted: true, rejected: false });
});

test('Int<Min,Max> with min greater than max is reported as unsupported at build time', () => {
  const project = emit([
    "import type { Int } from 'ts-typed';",
    'const value: Int<150, 0> = 10;',
    'void value;',
  ].join('\n'));

  const diagnostic = project.analysisDiagnostics.find((item) => item.code === 'TT_UNSUPPORTED_TYPE');
  assert.equal(diagnostic?.status, 'unsupported');
  assert.match(diagnostic?.message ?? '', /min \(150\) greater than max \(0\)/);
});
