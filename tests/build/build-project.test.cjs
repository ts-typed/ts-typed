'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { buildProject } = require('../../dist/compiler/build');

const PACKAGE_DIST = join(__dirname, '../../dist');

function writeProject(source, { extraFiles = {} } = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-build-'));
  const sourceRoot = join(projectRoot, 'src');
  const nodeModulesRoot = join(projectRoot, 'node_modules', '@ts-typed');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(nodeModulesRoot, { recursive: true });
  symlinkSync(PACKAGE_DIST, join(nodeModulesRoot, 'core'), 'dir');

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
        outDir: './staging-ignored',
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        skipLibCheck: true,
      },
      include: ['src/**/*.ts'],
    }),
  );
  writeFileSync(join(sourceRoot, 'main.ts'), source);
  for (const [relativePath, content] of Object.entries(extraFiles)) {
    const absolutePath = join(projectRoot, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
  }
  return projectRoot;
}

function baseConfig(projectRoot, overrides = {}) {
  return {
    $schema: './node_modules/@ts-typed/core/schema.json',
    integration: 'typescript',
    extends: null,
    entry: join(projectRoot, 'src/main.ts'),
    tsconfig: join(projectRoot, 'tsconfig.json'),
    outDir: join(projectRoot, 'dist'),
    extraProperties: 'error',
    compiler: { sourceMap: false, onUnsupported: 'warn', strictClass: false },
    ncc: {
      enabled: false,
      minify: false,
      sourceMap: false,
      sourceMapRegister: false,
      target: 'es2022',
      externals: [],
      cache: false,
      license: null,
      quiet: true,
      debugLog: false,
    },
    assets: [],
    diagnostics: { format: 'pretty', coverage: 'summary', reportFile: null },
    ...overrides,
  };
}

function runEntry(outDir, relativePath = 'main.js') {
  return spawnSync(process.execPath, [join(outDir, relativePath)], {
    cwd: outDir,
    encoding: 'utf8',
    timeout: 10_000,
    killSignal: 'SIGKILL',
  });
}

const MAIN_SOURCE = [
  "import { StrictTypeError } from '@ts-typed/core';",
  'interface IUser { name: string; age: number; }',
  'function expectTypeError(action: () => void): void {',
  '  try { action(); } catch (error) { if (error instanceof StrictTypeError) return; throw error; }',
  '  throw new Error("missing StrictTypeError");',
  '}',
  'const user: IUser = { name: "Ada", age: 30 };',
  'expectTypeError(() => { const invalid: any = { name: "Ada", age: "bad" }; const u: IUser = invalid; void u; });',
  'process.stdout.write(`${user.name}:${user.age}`);',
].join('\n');

test('an unbundled build emits instrumented JS that preserves StrictTypeError identity', async () => {
  const projectRoot = writeProject(MAIN_SOURCE);
  const config = baseConfig(projectRoot);

  const report = await buildProject(config);

  assert.equal(report.success, true, report.errors.join('\n'));
  assert.equal(report.bundled, false);
  assert.equal(existsSync(join(config.outDir, 'main.js')), true);

  const result = runEntry(config.outDir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Ada:30');
});

test('buildProject resolves the selected integration before creating the TypeScript program', async () => {
  const projectRoot = writeProject('process.stdout.write("integrated");');
  writeFileSync(
    join(projectRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'CommonJS',
        moduleResolution: 'Node',
        rootDir: './src',
        outDir: './ignored',
        skipLibCheck: true,
      },
      include: ['src/never-included.ts'],
    }),
  );
  writeFileSync(
    join(projectRoot, 'tsconfig.integration.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'CommonJS',
        moduleResolution: 'Node',
        rootDir: './src',
        outDir: './ignored',
        skipLibCheck: true,
      },
      include: ['src/main.ts', 'src/globals.d.ts'],
    }),
  );
  writeFileSync(
    join(projectRoot, 'integration.cjs'),
    [
      'module.exports = {',
      '  apiVersion: 1,',
      '  name: "fixture",',
      '  resolveProject(context) {',
      '    return { apiVersion: 1, integration: "fixture", projectRoot: context.projectRoot, configPath: require("node:path").join(context.projectRoot, "tsconfig.integration.json") };',
      '  },',
      '};',
    ].join('\n'),
  );

  const report = await buildProject(baseConfig(projectRoot, { integration: './integration.cjs' }));

  assert.equal(report.success, true, report.errors.join('\n'));
  assert.equal(runEntry(join(projectRoot, 'dist')).stdout, 'integrated');
});

test('compiler.onUnsupported=error fails the build and leaves a previously valid outDir untouched', async () => {
  const projectRoot = writeProject(MAIN_SOURCE);
  const config = baseConfig(projectRoot);

  const firstReport = await buildProject(config);
  assert.equal(firstReport.success, true, firstReport.errors.join('\n'));
  const markerPath = join(config.outDir, 'main.js');
  const previousContent = readFileSync(markerPath, 'utf8');

  const unsupportedSource = [
    'interface IValor<T> { valor: T; }',
    // A method makes the class unrepresentable as a structural object
    // schema (callable members cannot be validated), unlike a plain
    // data-only class, which now resolves structurally.
    'class ValueClass { name = "Ada"; greet(): string { return this.name; } }',
    'const v: IValor<ValueClass> = { valor: new ValueClass() };',
    'void v;',
  ].join('\n');
  writeFileSync(join(projectRoot, 'src/main.ts'), unsupportedSource);

  const strictConfig = baseConfig(projectRoot, {
    compiler: { sourceMap: false, onUnsupported: 'error', strictClass: false },
  });
  const secondReport = await buildProject(strictConfig);

  assert.equal(secondReport.success, false);
  assert.equal(secondReport.errors.length > 0, true);
  assert.equal(readFileSync(markerPath, 'utf8'), previousContent);
});

test('assets are copied relative to outDir and reported in the build result', async () => {
  const projectRoot = writeProject(MAIN_SOURCE, {
    extraFiles: { 'public/readme.txt': 'hello-asset' },
  });
  const config = baseConfig(projectRoot, {
    assets: [{ from: join(projectRoot, 'public/readme.txt'), to: 'static/readme.txt' }],
  });

  const report = await buildProject(config);

  assert.equal(report.success, true, report.errors.join('\n'));
  assert.deepEqual(report.assets, [{ from: join(projectRoot, 'public/readme.txt'), to: 'static/readme.txt' }]);
  assert.equal(readFileSync(join(config.outDir, 'static/readme.txt'), 'utf8'), 'hello-asset');
});

test('a bundled build (ncc) preserves the same StrictTypeError identity as the unbundled build', async () => {
  const projectRoot = writeProject(MAIN_SOURCE);
  const config = baseConfig(projectRoot, {
    ncc: {
      enabled: true,
      minify: false,
      sourceMap: false,
      sourceMapRegister: false,
      target: 'es2022',
      externals: [],
      cache: false,
      license: null,
      quiet: true,
      debugLog: false,
    },
  });

  const report = await buildProject(config);

  assert.equal(report.success, true, report.errors.join('\n'));
  assert.equal(report.bundled, true);
  assert.equal(existsSync(join(config.outDir, 'index.js')), true);

  const result = runEntry(config.outDir, 'index.js');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Ada:30');
});

test('TS_TYPED_BUILD_METRICS is off by default: no metrics field, no stderr output', async () => {
  const projectRoot = writeProject(MAIN_SOURCE);
  const config = baseConfig(projectRoot);
  delete process.env.TS_TYPED_BUILD_METRICS;

  const report = await buildProject(config);

  assert.equal(report.success, true, report.errors.join('\n'));
  assert.equal(report.metrics, undefined);
});

test('TS_TYPED_BUILD_METRICS=1 attaches per-stage timing to the report and prints the formatted summary', async () => {
  const projectRoot = writeProject(MAIN_SOURCE);
  const config = baseConfig(projectRoot);

  const originalConsoleError = console.error;
  const printedLines = [];
  console.error = (line) => printedLines.push(line);
  process.env.TS_TYPED_BUILD_METRICS = '1';
  let report;
  try {
    report = await buildProject(config);
  } finally {
    console.error = originalConsoleError;
    delete process.env.TS_TYPED_BUILD_METRICS;
  }

  assert.equal(report.success, true, report.errors.join('\n'));
  assert.notEqual(report.metrics, undefined);
  assert.equal(typeof report.metrics.projectLoad, 'number');
  assert.equal(typeof report.metrics.typeAnalysis, 'number');
  assert.equal(typeof report.metrics.astTransform, 'number');
  assert.equal(typeof report.metrics.jsEmission, 'number');
  assert.equal(typeof report.metrics.bundling, 'number');
  assert.equal(typeof report.metrics.total, 'number');
  assert.equal(printedLines.length, 1);
  assert.match(printedLines[0], /TypeSafe Build Performance/);
  assert.match(printedLines[0], /Total/);
});

const DECORATED_SOURCE = [
  "import { StrictTypeError } from '@ts-typed/core';",
  'function tag(target: object, key: string): void { void target; void key; }',
  'class Person { @tag name = "Ada"; }',
  'const person: Person = new Person();',
  'process.stdout.write(person.name);',
].join('\n');

// Behavior change: a decorator no longer makes a member unsupported. A decorated
// field whose type is supported is resolved and guarded like any other field,
// so it must NOT produce the old "Decorated members" warning.
test('a decorated field with a supported type produces no unsupported warning', async () => {
  const projectRoot = writeProject(DECORATED_SOURCE);
  const config = baseConfig(projectRoot);

  const report = await buildProject(config);

  assert.equal(report.success, true, report.errors.join('\n'));
  const warning = report.coverage.warnings.find((entry) => entry.name === 'name');
  assert.equal(warning, undefined, JSON.stringify(report.coverage.warnings));
});

// A decorated member whose TYPE is genuinely unsupported (a generic type parameter — Date and a plain
// callable are now both supported leaves) still fails under onUnsupported=error, so decorators did not
// silently disable the check.
const DECORATED_UNSUPPORTED_SOURCE = [
  "import { StrictTypeError } from '@ts-typed/core';",
  'function tag(target: object, key: string): void { void target; void key; }',
  'class Event<T> { @tag when: T; constructor(when: T) { this.when = when; } }',
  'const event: Event<number> = new Event(0);',
  'process.stdout.write(String(event.when));',
].join('\n');

test('compiler.onUnsupported=error still fails a decorated member whose type is unsupported', async () => {
  const projectRoot = writeProject(DECORATED_UNSUPPORTED_SOURCE);
  const config = baseConfig(projectRoot, {
    compiler: { sourceMap: false, onUnsupported: 'error', strictClass: false },
  });

  const report = await buildProject(config);

  assert.equal(report.success, false);
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /main\.ts:3:\d+ warning TT_UNSUPPORTED_TYPE: when /);
});

function enablePathAliases(projectRoot) {
  writeFileSync(
    join(projectRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'CommonJS',
        moduleResolution: 'Node',
        rootDir: './src',
        outDir: './staging-ignored',
        baseUrl: '.',
        paths: { '@app/*': ['src/*'] },
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        skipLibCheck: true,
      },
      include: ['src/**/*.ts'],
    }),
  );
  writeFileSync(join(projectRoot, 'src/util.ts'), 'export const greeting = "aliased";\n');
}

const ALIAS_MAIN_SOURCE = [
  "import { greeting } from '@app/util';",
  "process.stdout.write(greeting);",
].join('\n');

const NCC_ENABLED = {
  enabled: true,
  minify: false,
  sourceMap: false,
  sourceMapRegister: false,
  target: 'es2022',
  externals: [],
  cache: false,
  license: null,
  quiet: true,
  debugLog: false,
};

test('a project with tsconfig "paths" builds and runs correctly when the bundle (ncc) is disabled', async () => {
  const projectRoot = writeProject(ALIAS_MAIN_SOURCE);
  enablePathAliases(projectRoot);
  const config = baseConfig(projectRoot);

  const report = await buildProject(config);

  assert.equal(report.success, true, report.errors.join('\n'));
  assert.equal(report.bundled, false);
  assert.equal(existsSync(join(config.outDir, 'main.js')), true);
  // The emitted require() must be relative, not the literal "@app/util" alias Node can't resolve.
  const emitted = readFileSync(join(config.outDir, 'main.js'), 'utf8');
  assert.match(emitted, /require\(["']\.\/util["']\)/);
  assert.doesNotMatch(emitted, /@app\/util/);
  assert.equal(runEntry(config.outDir).stdout, 'aliased');
});

test('a project with tsconfig "paths" builds and runs correctly when the bundle (ncc) is enabled too', async () => {
  const projectRoot = writeProject(ALIAS_MAIN_SOURCE);
  enablePathAliases(projectRoot);
  const config = baseConfig(projectRoot, { ncc: NCC_ENABLED });

  const report = await buildProject(config);

  assert.equal(report.success, true, report.errors.join('\n'));
  assert.equal(report.bundled, true);
  assert.equal(runEntry(config.outDir, 'index.js').stdout, 'aliased');
});

test('export-from and `require()`/dynamic `import()` through a "paths" alias are all rewritten too', async () => {
  const REEXPORT_AND_REQUIRE_SOURCE = [
    "declare function require(moduleName: string): any;",
    "export { greeting } from '@app/util';",
    "const required = require('@app/util').greeting;",
    "import('@app/util').then((m: any) => {",
    "  process.stdout.write(`${required}:${m.greeting}`);",
    "});",
  ].join('\n');
  const projectRoot = writeProject(REEXPORT_AND_REQUIRE_SOURCE);
  enablePathAliases(projectRoot);
  const config = baseConfig(projectRoot);

  const report = await buildProject(config);

  assert.equal(report.success, true, report.errors.join('\n'));
  const emitted = readFileSync(join(config.outDir, 'main.js'), 'utf8');
  assert.doesNotMatch(emitted, /@app\/util/);
  assert.equal(runEntry(config.outDir).stdout, 'aliased:aliased');
});

test('a "paths" alias that resolves to nothing on disk fails the build up front, with a precise file:line pointer', async () => {
  const MISSING_ALIAS_SOURCE = "import { missing } from '@app/does-not-exist';\nprocess.stdout.write(String(missing));\n";
  const projectRoot = writeProject(MISSING_ALIAS_SOURCE);
  enablePathAliases(projectRoot);
  const config = baseConfig(projectRoot);

  const report = await buildProject(config);

  assert.equal(report.success, false);
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /main\.ts:1:/);
  assert.match(report.errors[0], /@app\/does-not-exist/);
  assert.equal(existsSync(join(config.outDir, 'main.js')), false);
});

test('a project without tsconfig "paths" still builds when the bundle (ncc) is disabled', async () => {
  const projectRoot = writeProject(MAIN_SOURCE);
  const config = baseConfig(projectRoot);

  const report = await buildProject(config);

  assert.equal(report.success, true, report.errors.join('\n'));
  assert.equal(report.bundled, false);
  assert.equal(runEntry(config.outDir).stdout, 'Ada:30');
});
