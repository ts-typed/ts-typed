'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { analyzeProject } = require('../../../dist/compiler/analysis');
const { createContractTransformer } = require('../../../dist/compiler/transform');

const runtimeModule = join(__dirname, '../../../dist/runtime');

function writeProject(files) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-transform-'));
  const sourceRoot = join(projectRoot, 'src');
  const declarationRoot = join(projectRoot, 'node_modules', 'ts-typed');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(declarationRoot, { recursive: true });
  writeFileSync(
    join(declarationRoot, 'index.d.ts'),
    [
      'export class StrictTypeError extends TypeError {}',
      "export function ExtraProperties(policy: 'error' | 'strip'): ClassDecorator & PropertyDecorator;",
    ].join('\n'),
  );
  writeFileSync(
    join(sourceRoot, 'globals.d.ts'),
    'declare const process: { stdout: { write(chunk: string): boolean } };\n',
  );
  writeFileSync(
    join(projectRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'CommonJS',
        moduleResolution: 'Node',
        rootDir: './src',
        outDir: './out',
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        skipLibCheck: true,
      },
      include: ['src/**/*.ts'],
    }),
  );
  for (const [relativePath, source] of Object.entries(files)) {
    const absolutePath = join(sourceRoot, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, source);
  }
  return { projectRoot, tsconfigPath: join(projectRoot, 'tsconfig.json') };
}

function emitProject(files, transformerOptions = {}) {
  const project = writeProject(files);
  const analysis = analyzeProject({ tsconfigPath: project.tsconfigPath });
  assert.equal(
    analysis.tsDiagnostics.length,
    0,
    analysis.tsDiagnostics.map((diagnostic) => diagnostic.messageText).join('\n'),
  );
  const diagnostics = [];
  const emitResult = analysis.program.emit(
    undefined,
    undefined,
    undefined,
    false,
    {
      before: [
        createContractTransformer({
          analysis,
          runtimeModule,
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
          ...transformerOptions,
        }),
      ],
    },
  );
  assert.equal(emitResult.emitSkipped, false);
  return { ...project, diagnostics, outputRoot: join(project.projectRoot, 'out') };
}

function runEntry(project, relativePath = 'main.js') {
  return spawnSync(process.execPath, [join(project.outputRoot, relativePath)], {
    cwd: project.projectRoot,
    encoding: 'utf8',
  });
}

function runMain(source, transformerOptions) {
  const project = emitProject({ 'main.ts': source }, transformerOptions);
  const result = runEntry(project);
  assert.equal(result.status, 0, result.stderr);
  return { project, output: JSON.parse(result.stdout) };
}

const ATTEMPT = [
  "import { StrictTypeError } from 'ts-typed';",
  'function attempt(action: () => void): string {',
  '  try { action(); return "ok"; } catch (error) {',
  '    return error instanceof StrictTypeError ? "strict" : "other";',
  '  }',
  '}',
].join('\n');

test('public static field validates writes and keeps valid values', () => {
  const { output } = runMain([
    ATTEMPT,
    'class Config { static version: string = "1.0"; }',
    'const results = {',
    '  initial: Config.version,',
    '  valid: attempt(() => { (Config as any).version = "2.0"; }),',
    '  invalid: attempt(() => { (Config as any).version = 123; }),',
    '  afterInvalid: Config.version,',
    '};',
    'process.stdout.write(JSON.stringify(results));',
  ].join('\n'));

  assert.deepEqual(output, { initial: '1.0', valid: 'ok', invalid: 'strict', afterInvalid: '2.0' });
});

test('required static field without initializer is guarded when assigned later', () => {
  const { output } = runMain([
    ATTEMPT,
    'class Holder { static label: string; }',
    'const results = {',
    '  initialUndefined: Holder.label === undefined,',
    '  valid: attempt(() => { (Holder as any).label = "x"; }),',
    '  invalid: attempt(() => { (Holder as any).label = 42; }),',
    '  label: Holder.label,',
    '};',
    'process.stdout.write(JSON.stringify(results));',
  ].join('\n'));

  assert.deepEqual(output, { initialUndefined: true, valid: 'ok', invalid: 'strict', label: 'x' });
});

test('required static field resists delete and defineProperty', () => {
  const { output } = runMain([
    'class Settings { static mode: string = "a"; }',
    'const results = {',
    '  deleted: Reflect.deleteProperty(Settings, "mode"),',
    '  redefined: Reflect.defineProperty(Settings, "mode", { value: "b" }),',
    '  mode: Settings.mode,',
    '};',
    'process.stdout.write(JSON.stringify(results));',
  ].join('\n'));

  assert.deepEqual(output, { deleted: false, redefined: false, mode: 'a' });
});

test('readonly static field is locked after the class definition', () => {
  const { output } = runMain([
    ATTEMPT,
    'class Constants { static readonly id: string = "a"; }',
    'const results = {',
    '  initial: Constants.id,',
    '  write: attempt(() => { (Constants as any).id = "b"; }),',
    '  id: Constants.id,',
    '};',
    'process.stdout.write(JSON.stringify(results));',
  ].join('\n'), { enforceReadonly: true });

  assert.notEqual(output.write, 'ok');
  assert.equal(output.initial, 'a');
  assert.equal(output.id, 'a');
});

test('static and instance fields in the same class work independently', () => {
  const { output } = runMain([
    ATTEMPT,
    'class Mixed {',
    '  static version: string = "1.0";',
    '  name: string = "x";',
    '  constructor(public_name?: string) { if (public_name !== undefined) this.name = public_name; }',
    '}',
    'const instance = new Mixed("ada");',
    'const results = {',
    '  staticInitial: Mixed.version,',
    '  instanceName: instance.name,',
    '  staticInvalid: attempt(() => { (Mixed as any).version = 1; }),',
    '  instanceInvalid: attempt(() => { (instance as any).name = 1; }),',
    '  staticAfter: Mixed.version,',
    '  instanceAfter: instance.name,',
    '};',
    'process.stdout.write(JSON.stringify(results));',
  ].join('\n'));

  assert.deepEqual(output, {
    staticInitial: '1.0',
    instanceName: 'ada',
    staticInvalid: 'strict',
    instanceInvalid: 'strict',
    staticAfter: '1.0',
    instanceAfter: 'ada',
  });
});

test('static fields remain reachable through inheritance', () => {
  const { output } = runMain([
    ATTEMPT,
    'class Base { static value: number = 1; }',
    'class Derived extends Base {}',
    'const results = {',
    '  inherited: Derived.value,',
    '  baseInvalid: attempt(() => { (Base as any).value = "bad"; }),',
    '  derivedValid: attempt(() => { (Derived as any).value = 5; }),',
    '  baseValue: Base.value,',
    '};',
    'process.stdout.write(JSON.stringify(results));',
  ].join('\n'));

  assert.equal(output.inherited, 1);
  assert.equal(output.baseInvalid, 'strict');
  assert.equal(output.derivedValid, 'ok');
  assert.equal(output.baseValue, 5);
});

test('static private and protected fields stay unguarded', () => {
  const { project, output } = runMain([
    ATTEMPT,
    'class Secrets {',
    '  private static hidden: number = 1;',
    '  protected static guarded: number = 2;',
    '}',
    'const results = {',
    '  privateWrite: attempt(() => { (Secrets as any).hidden = "bad"; }),',
    '  protectedWrite: attempt(() => { (Secrets as any).guarded = "bad"; }),',
    '  hidden: (Secrets as any).hidden,',
    '  guarded: (Secrets as any).guarded,',
    '};',
    'process.stdout.write(JSON.stringify(results));',
  ].join('\n'));

  assert.equal(output.privateWrite, 'ok');
  assert.equal(output.protectedWrite, 'ok');
  assert.equal(output.hidden, 'bad');
  assert.equal(output.guarded, 'bad');
  const analysis = analyzeProject({ tsconfigPath: project.tsconfigPath });
  const reasons = [...analysis.contracts.values()]
    .filter((descriptor) => descriptor.name === 'hidden' || descriptor.name === 'guarded')
    .map((descriptor) => descriptor.resolution);
  assert.equal(reasons.length, 2);
  for (const resolution of reasons) {
    assert.equal(resolution.status, 'unsupported');
    assert.match(resolution.reason, /Private, protected, and static members/);
  }
});
