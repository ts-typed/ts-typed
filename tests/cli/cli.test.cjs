'use strict';

const assert = require('node:assert/strict');
const { chmodSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const { runCli } = require('../../dist/cli');
const { parseNestCommand } = require('../../dist/cli/nest-command');
const { configureNestProjectScripts } = require('../../dist/config');

const PACKAGE_DIST = join(__dirname, '../../dist');

function writeConsumerProject() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ts-typed-cli-'));
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
        outDir: './unused',
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        skipLibCheck: true,
      },
      include: ['src/**/*.ts'],
    }),
  );
  writeFileSync(
    join(sourceRoot, 'main.ts'),
    [
      "import { StrictTypeError } from '@ts-typed/core';",
      'const value: number = 1;',
      'try { const invalid: any = "bad"; const n: number = invalid; void n; }',
      'catch (error) { if (!(error instanceof StrictTypeError)) throw error; }',
      'process.stdout.write(String(value));',
    ].join('\n'),
  );

  const configPath = join(projectRoot, 'typets.config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      $schema: './node_modules/@ts-typed/core/schema.json',
      integration: 'typescript',
      extends: null,
      entry: 'src/main.ts',
      tsconfig: 'tsconfig.json',
      outDir: 'dist',
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
    }),
  );

  return { projectRoot, configPath };
}

test('no command and "help" print usage and exit 0', async () => {
  const noArgs = await runCli([]);
  assert.equal(noArgs.exitCode, 0);
  assert.match(noArgs.stdout.join('\n'), /Usage:/);

  const help = await runCli(['help']);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout.join('\n'), /Usage:/);
});

test('an unknown command exits with the usage exit code', async () => {
  const result = await runCli(['bogus-command']);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr.join('\n'), /Unknown command/);
});

test('init creates typets.config.json once and is idempotent on a second run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ts-typed-cli-init-'));

  const first = await runCli(['init', '--root', root]);
  assert.equal(first.exitCode, 0);
  assert.match(first.stdout.join('\n'), /Created/);
  const configPath = join(root, 'typets.config.json');
  assert.equal(existsSync(configPath), true);
  const firstContent = readFileSync(configPath, 'utf8');

  const second = await runCli(['init', '--root', root]);
  assert.equal(second.exitCode, 0);
  assert.match(second.stdout.join('\n'), /already exists/);
  assert.equal(readFileSync(configPath, 'utf8'), firstContent);
});

test('init asks to install the Nest global filter and delegates the opted-in setup to the Nest adapter', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ts-typed-cli-nest-init-'));
  const adapterDirectory = join(root, 'node_modules', '@ts-typed', 'nestjs');
  mkdirSync(adapterDirectory, { recursive: true });
  writeFileSync(join(root, 'nest-cli.json'), JSON.stringify({ sourceRoot: 'src' }));
  writeFileSync(
    join(adapterDirectory, 'index.js'),
    [
      "const { writeFileSync } = require('node:fs');",
      'module.exports = {',
      '  apiVersion: 1,',
      "  name: 'nestjs',",
      '  resolveProject: (context) => ({ apiVersion: 1, integration: "nestjs", projectRoot: context.projectRoot }),',
      '  installGlobalStrictTypeErrorFilter: (context) => {',
      "    writeFileSync(require('node:path').join(context.projectRoot, 'filter-installed'), 'yes');",
      "    return { changed: true, message: 'Registered global filter.' };",
      '  },',
      '};',
    ].join('\n'),
  );

  let asked = '';
  const result = await runCli(['init', '--root', root], {
    confirm: async (question) => {
      if (asked === '') {
        asked = question;
      }
      return true;
    },
    installDependency: async (projectRoot, packageName) => ({ installed: true, message: `Installed ${packageName}.` }),
  });

  assert.equal(result.exitCode, 0, result.stderr.join('\n'));
  assert.match(asked, /Register StrictTypeErrorFilter globally/);
  assert.equal(readFileSync(join(root, 'filter-installed'), 'utf8'), 'yes');
  assert.equal(JSON.parse(readFileSync(join(root, 'typets.config.json'), 'utf8')).integration, '@ts-typed/nestjs');
  assert.match(result.stdout.join('\n'), /Registered global filter/);
});

test('init configures conventional Nest scripts to invoke the ts-typed Nest command once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ts-typed-cli-nest-scripts-'));
  const adapterDirectory = join(root, 'node_modules', '@ts-typed', 'nestjs');
  mkdirSync(adapterDirectory, { recursive: true });
  writeFileSync(join(root, 'nest-cli.json'), JSON.stringify({ sourceRoot: 'src' }));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      scripts: {
        build: 'nest build',
        start: 'nest start',
        'start:dev': 'nest start --watch',
        'start:debug': 'nest start --debug --watch',
        'start:prod': 'node dist/main',
        lint: 'eslint "{src,apps,libs,test}/**/*.ts"',
      },
    }, null, 2),
  );
  writeFileSync(
    join(adapterDirectory, 'index.js'),
    "module.exports = { apiVersion: 1, name: 'nestjs', resolveProject: (context) => ({ apiVersion: 1, integration: 'nestjs', projectRoot: context.projectRoot }) };\n",
  );

  const installDependency = async (projectRoot, packageName) => ({ installed: true, message: `Installed ${packageName}.` });
  const first = await runCli(['init', '--root', root], { installDependency });
  assert.equal(first.exitCode, 0, first.stderr.join('\n'));
  assert.match(first.stdout.join('\n'), /Configured Nest npm scripts/);
  assert.doesNotMatch(first.stdout.join('\n'), /build: ts-typed build/);
  const firstManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(firstManifest.scripts, {
    build: 'ts-typed nest build',
    start: 'ts-typed nest start',
    'start:dev': 'ts-typed nest start --watch',
    'start:debug': 'ts-typed nest start --debug --watch',
    'start:prod': 'node dist/main',
    lint: 'eslint "{src,apps,libs,test}/**/*.ts"',
  });

  const second = await runCli(['init', '--root', root], { installDependency });
  assert.equal(second.exitCode, 0, second.stderr.join('\n'));
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')), firstManifest);
});

test('Nest script setup leaves custom compiler flags untouched', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ts-typed-cli-nest-custom-script-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { build: 'nest build --webpack', start: 'nest start --config custom.json' } }),
  );

  const result = await configureNestProjectScripts(root);

  assert.equal(result.changed, false);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts, {
    build: 'nest build --webpack',
    start: 'nest start --config custom.json',
  });
});

test('nest build compiles a TypeScript-builder project without bundling', async () => {
  const { projectRoot } = writeConsumerProject();
  writeFileSync(
    join(projectRoot, 'nest-cli.json'),
    JSON.stringify({ sourceRoot: 'src', compilerOptions: { builder: 'tsc', tsConfigPath: 'tsconfig.json' } }),
  );

  const result = await runCli(['nest', 'build', '--root', projectRoot]);

  assert.equal(result.exitCode, 0, result.stderr.join('\n'));
  assert.match(result.stdout.join('\n'), /Nest build succeeded/);
  assert.equal(existsSync(join(projectRoot, 'dist', 'main.js')), true);
});

test('nest build rejects SWC before emitting a potentially unprotected build', async () => {
  const { projectRoot } = writeConsumerProject();
  writeFileSync(
    join(projectRoot, 'nest-cli.json'),
    JSON.stringify({ sourceRoot: 'src', compilerOptions: { builder: 'swc', tsConfigPath: 'tsconfig.json' } }),
  );

  const result = await runCli(['nest', 'build', '--root', projectRoot]);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr.join('\n'), /SWC.*not supported/i);
});

test('nest start builds and executes the emitted Nest entry point', async () => {
  const { projectRoot } = writeConsumerProject();
  writeFileSync(
    join(projectRoot, 'nest-cli.json'),
    JSON.stringify({ sourceRoot: 'src', compilerOptions: { builder: 'tsc', tsConfigPath: 'tsconfig.json' } }),
  );

  const result = await runCli(['nest', 'start', '--root', projectRoot]);

  assert.equal(result.exitCode, 0, result.stderr.join('\n'));
  assert.match(result.stdout.join('\n'), /Nest application exited successfully/);
});

test('nest start accepts watch and debug flags from conventional Nest scripts', () => {
  const parsed = parseNestCommand(['start', '--debug', '--watch', '--root', '/tmp/nest-project']);

  assert.equal(parsed.error, undefined);
  assert.equal(parsed.command, 'start');
  assert.equal(parsed.debug, true);
  assert.equal(parsed.watch, true);
  assert.equal(parsed.projectRoot, '/tmp/nest-project');
});

test('npm run build and npm start execute the Nest wrapper installed by init', async () => {
  const { projectRoot } = writeConsumerProject();
  const binaryDirectory = join(projectRoot, 'node_modules', '.bin');
  const binaryPath = join(binaryDirectory, 'ts-typed');
  mkdirSync(binaryDirectory, { recursive: true });
  writeFileSync(
    binaryPath,
    [
      `#!${process.execPath}`,
      `const { runCli } = require(${JSON.stringify(join(PACKAGE_DIST, 'cli', 'index.js'))});`,
      'void runCli(process.argv.slice(2)).then((result) => {',
      '  for (const line of result.stdout) process.stdout.write(`${line}\\n`);',
      '  for (const line of result.stderr) process.stderr.write(`${line}\\n`);',
      '  process.exitCode = result.exitCode;',
      '});',
      '',
    ].join('\n'),
  );
  chmodSync(binaryPath, 0o755);
  writeFileSync(
    join(projectRoot, 'nest-cli.json'),
    JSON.stringify({ sourceRoot: 'src', compilerOptions: { builder: 'tsc', tsConfigPath: 'tsconfig.json' } }),
  );
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({ scripts: { build: 'ts-typed nest build', start: 'ts-typed nest start' } }),
  );

  const buildOutput = execFileSync('npm', ['run', 'build'], { cwd: projectRoot, encoding: 'utf8' });
  const startOutput = execFileSync('npm', ['start'], { cwd: projectRoot, encoding: 'utf8' });

  assert.match(buildOutput, /Nest build succeeded/);
  assert.match(startOutput, /Nest application exited successfully/);
  assert.equal(existsSync(join(projectRoot, 'dist', 'main.js')), true);
});

test('build runs an unbundled project end to end and reports success', async () => {
  const { configPath } = writeConsumerProject();
  const result = await runCli(['build', '--config', configPath]);

  assert.equal(result.exitCode, 0, result.stderr.join('\n'));
  assert.match(result.stdout.join('\n'), /Build succeeded/);
});

test('build reports a non-zero exit code and the configuration error for a missing config file', async () => {
  const missingPath = join(tmpdir(), `does-not-exist-${Date.now()}.json`);
  const result = await runCli(['build', '--config', missingPath]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr.length > 0, true);
});

test('build --no-bundle overrides ncc.enabled for a single run without persisting the override', async () => {
  const { configPath } = writeConsumerProject();

  const result = await runCli(['build', '--config', configPath, '--no-bundle']);
  assert.equal(result.exitCode, 0, result.stderr.join('\n'));
  assert.doesNotMatch(result.stdout.join('\n'), /bundled/);

  const configOnDisk = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(configOnDisk.ncc.enabled, false, 'unchanged: config already had ncc disabled');
});

test('an unrecognized build flag exits with the usage exit code', async () => {
  const { configPath } = writeConsumerProject();
  const result = await runCli(['build', '--config', configPath, '--does-not-exist']);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr.join('\n'), /Unknown build option/);
});

function configureDiagnosticsReport(configPath, reportFile) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.diagnostics = { ...config.diagnostics, reportFile };
  writeFileSync(configPath, JSON.stringify(config));
}

test('build writes the coverage report as JSON to diagnostics.reportFile, creating missing parent directories', async () => {
  const { projectRoot, configPath } = writeConsumerProject();
  configureDiagnosticsReport(configPath, './reports/coverage.json');

  const result = await runCli(['build', '--config', configPath]);
  assert.equal(result.exitCode, 0, result.stderr.join('\n'));

  const reportPath = join(projectRoot, 'reports', 'coverage.json');
  assert.equal(existsSync(reportPath), true);
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.ok(Array.isArray(report.items));
  assert.ok(Array.isArray(report.warnings));
  assert.ok(Array.isArray(report.files));
  const stdoutText = result.stdout.join('\n');
  assert.match(stdoutText, /Diagnostics report written to .*reports\/coverage\.json$/m);

  const summary = stdoutText.match(/^(\S+): (\d+) protected, (\d+) partial, (\d+) unsupported, (\d+) open$/m);
  assert.ok(summary, 'stdout contains a per-file coverage summary');
  assert.equal(report.files.length, 1);
  assert.equal(report.files[0].file.endsWith(summary[1]), true);
  assert.deepEqual(
    [report.files[0].protected, report.files[0].partial, report.files[0].unsupported, report.files[0].open],
    [Number(summary[2]), Number(summary[3]), Number(summary[4]), Number(summary[5])],
  );
});

test('build without diagnostics.reportFile writes no report file', async () => {
  const { projectRoot, configPath } = writeConsumerProject();

  const result = await runCli(['build', '--config', configPath]);
  assert.equal(result.exitCode, 0, result.stderr.join('\n'));
  assert.doesNotMatch(result.stdout.join('\n'), /Diagnostics report written/);
  assert.equal(existsSync(join(projectRoot, 'reports')), false);
});

test('build reports a failure when diagnostics.reportFile cannot be written', async () => {
  const { projectRoot, configPath } = writeConsumerProject();
  // A regular file where the report's parent directory should be cannot be created as a directory.
  writeFileSync(join(projectRoot, 'blocker'), 'not a directory');
  configureDiagnosticsReport(configPath, './blocker/coverage.json');

  const result = await runCli(['build', '--config', configPath]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout.length, 0);
  assert.match(result.stderr.join('\n'), /Could not write diagnostics report to .*blocker/);
});

test('start builds a plain TypeScript project once and runs it to completion', async () => {
  const { projectRoot } = writeConsumerProject();

  const result = await runCli(['start', '--root', projectRoot]);

  assert.equal(result.exitCode, 0, result.stderr.join('\n'));
  assert.match(result.stdout.join('\n'), /Application exited successfully/);
});

test('start detects a Nest project and runs the unbundled Nest entry point', async () => {
  const { projectRoot } = writeConsumerProject();
  writeFileSync(
    join(projectRoot, 'nest-cli.json'),
    JSON.stringify({ sourceRoot: 'src', compilerOptions: { builder: 'tsc', tsConfigPath: 'tsconfig.json' } }),
  );
  writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ dependencies: { '@nestjs/core': '^12.0.0' } }));

  const result = await runCli(['start', '--root', projectRoot]);

  assert.equal(result.exitCode, 0, result.stderr.join('\n'));
  assert.equal(existsSync(join(projectRoot, 'dist', 'main.js')), true);
});

test('start rejects an unsupported Nest builder the same way "nest start" does', async () => {
  const { projectRoot } = writeConsumerProject();
  writeFileSync(
    join(projectRoot, 'nest-cli.json'),
    JSON.stringify({ sourceRoot: 'src', compilerOptions: { builder: 'swc' } }),
  );
  writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ dependencies: { '@nestjs/core': '^12.0.0' } }));

  const result = await runCli(['start', '--root', projectRoot]);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr.join('\n'), /not supported by ts-typed/);
});

test('start falls back to the plain TypeScript path when @nestjs/core is present but nest-cli.json is absent', async () => {
  const { projectRoot } = writeConsumerProject();
  writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ dependencies: { '@nestjs/core': '^12.0.0' } }));

  const result = await runCli(['start', '--root', projectRoot]);

  assert.equal(result.exitCode, 0, result.stderr.join('\n'));
  assert.match(result.stdout.join('\n'), /Application exited successfully/);
});

test('build falls back to the plain TypeScript path when @nestjs/core is present but nest-cli.json is absent', async () => {
  const { projectRoot, configPath } = writeConsumerProject();
  writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ dependencies: { '@nestjs/core': '^12.0.0' } }));

  const result = await runCli(['build', '--config', configPath]);

  assert.equal(result.exitCode, 0, result.stderr.join('\n'));
  assert.match(result.stdout.join('\n'), /Build succeeded/);
});

test('build bundles a plain TypeScript project by default', async () => {
  const { projectRoot, configPath } = writeConsumerProject();
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.ncc.enabled = true;
  writeFileSync(configPath, JSON.stringify(config));

  const result = await runCli(['build', '--config', configPath]);

  assert.equal(result.exitCode, 0, result.stderr.join('\n'));
  assert.equal(existsSync(join(projectRoot, 'dist', 'index.js')), true);
});

test('build detects a Nest project and produces an unbundled dist/main.js without the "nest" subcommand', async () => {
  const { projectRoot, configPath } = writeConsumerProject();
  writeFileSync(
    join(projectRoot, 'nest-cli.json'),
    JSON.stringify({ sourceRoot: 'src', compilerOptions: { builder: 'tsc', tsConfigPath: 'tsconfig.json' } }),
  );
  writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ dependencies: { '@nestjs/core': '^12.0.0' } }));

  const result = await runCli(['build', '--config', configPath]);

  assert.equal(result.exitCode, 0, result.stderr.join('\n'));
  assert.equal(existsSync(join(projectRoot, 'dist', 'main.js')), true);
});

test('start with the default bundled config runs the bundled dist/index.js and keeps it in place', async () => {
  const { projectRoot, configPath } = writeConsumerProject();
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.ncc.enabled = true;
  writeFileSync(configPath, JSON.stringify(config));

  const build = await runCli(['build', '--config', configPath]);
  assert.equal(build.exitCode, 0, build.stderr.join('\n'));
  assert.equal(existsSync(join(projectRoot, 'dist', 'index.js')), true);

  const result = await runCli(['start', '--root', projectRoot]);

  assert.equal(result.exitCode, 0, result.stderr.join('\n'));
  assert.match(result.stdout.join('\n'), /Application exited successfully/);
  assert.equal(existsSync(join(projectRoot, 'dist', 'index.js')), true);
  assert.equal(existsSync(join(projectRoot, 'dist', 'main.js')), false);
  assert.equal(execFileSync(process.execPath, [join(projectRoot, 'dist', 'index.js')]).toString(), '1');
});

test('start --watch is accepted, starts the watch loop, and stops cleanly on SIGINT', async () => {
  const { projectRoot } = writeConsumerProject();

  const running = runCli(['start', '--root', projectRoot, '--watch']);
  const deadline = Date.now() + 20000;
  while (!existsSync(join(projectRoot, 'dist', 'main.js')) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  process.emit('SIGINT');
  const result = await running;

  assert.equal(result.exitCode, 0, result.stderr.join('\n'));
  assert.match(result.stdout.join('\n'), /ts-typed watch stopped/);
});

test('start accepts -w and --debug without the unknown-option error', async () => {
  const { projectRoot } = writeConsumerProject();
  const missingConfig = join(projectRoot, 'missing.config.json');

  const result = await runCli(['start', '--root', projectRoot, '--debug', '-w', '--config', missingConfig]);

  assert.equal(result.exitCode, 1);
  assert.doesNotMatch(result.stderr.join('\n'), /Unknown start option/);
});

test('init on a plain TypeScript project writes build/start/dev/start:prod scripts and offers to install validators', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ts-typed-cli-plain-init-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
  const questions = [];

  const result = await runCli(['init', '--root', root], {
    confirm: async (question) => {
      questions.push(question);
      return false;
    },
  });

  assert.equal(result.exitCode, 0, result.stderr.join('\n'));
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts, {
    build: 'ts-typed build',
    start: 'ts-typed start',
    dev: 'ts-typed start --watch',
    'start:prod': 'node dist/index.js',
  });
  assert.equal(questions.length, 1);
  assert.match(questions[0], /@ts-typed\/validators/);
});

test('init on an Express project installs @ts-typed/express, writes its scripts, and offers both prompts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ts-typed-cli-express-init-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { express: '^5.0.0' } }));
  const adapterDirectory = join(root, 'node_modules', '@ts-typed', 'express');
  const installed = [];
  const questions = [];

  const result = await runCli(['init', '--root', root], {
    installDependency: async (projectRoot, packageName) => {
      installed.push(packageName);
      mkdirSync(adapterDirectory, { recursive: true });
      writeFileSync(
        join(adapterDirectory, 'index.js'),
        [
          'module.exports = {',
          '  apiVersion: 1,',
          "  name: 'express',",
          '  resolveProject: (context) => ({ apiVersion: 1, integration: "express", projectRoot: context.projectRoot }),',
          '  installGlobalStrictTypeErrorFilter: (context) => ({ changed: true, message: "Registered the global error handler." }),',
          '};',
        ].join('\n'),
      );
      return { installed: true, message: `Installed ${packageName}.` };
    },
    confirm: async (question) => {
      questions.push(question);
      return question.includes('error handler');
    },
  });

  assert.equal(result.exitCode, 0, result.stderr.join('\n'));
  assert.equal(questions.length, 2);
  assert.match(questions[0], /error handler/);
  assert.match(questions[1], /@ts-typed\/validators/);
  assert.match(result.stdout.join('\n'), /Registered the global error handler/);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts, {
    build: 'ts-typed build',
    start: 'ts-typed start',
    dev: 'ts-typed start --watch',
    'start:prod': 'node dist/index.js',
  });
});

test('init installs @ts-typed/nestjs automatically when a Nest project does not have it yet', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ts-typed-cli-nest-autoinstall-'));
  writeFileSync(join(root, 'nest-cli.json'), JSON.stringify({ sourceRoot: 'src' }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@nestjs/core': '^12.0.0' } }));
  const installCalls = [];

  // `installDependency` is passed as a test-only option (added to
  // RunCliOptions in Step 3 below) so this test never spawns a real
  // package manager; `installDependency`'s OWN default-runner behavior is
  // already covered by Task 3's unit tests.
  const result = await runCli(['init', '--root', root], {
    installDependency: async (projectRoot, packageName) => {
      installCalls.push(packageName);
      return { installed: true, message: `Installed ${packageName}.` };
    },
  });

  assert.equal(result.exitCode, 0, result.stderr.join('\n'));
  assert.deepEqual(installCalls, ['@ts-typed/nestjs']);
  assert.match(result.stdout.join('\n'), /Installed @ts-typed\/nestjs/);
});
