import { randomUUID } from 'node:crypto';
import { cp, mkdir, rename, rm, writeFile as writeFileAsync } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type ts from 'typescript';

import { analyzeProject } from '../analysis';
import type { CoverageDiagnostic } from '../analysis';
import { bundleProject } from '../../bundler';
import type { ProjectConfig } from '../../config';
import { resolveProject } from '../../integration';
import { createCoverageReport, formatCoverageReport } from '../report';
import { createContractTransformer } from '../transform';
import { findUnresolvableAliasedSpecifiers } from '../transform/resolve-path-alias';
import { formatBuildMetrics, isBuildMetricsEnabled, now } from './build-metrics';
import type { BuildStageMetrics } from './build-metrics';
import type { BuildAssetReport, BuildReport } from './build-report.interface';

const RUNTIME_PACKAGE = '@ts-typed/core';

interface EmitFileRecord {
  readonly relativePath: string;
}

export async function buildProject(config: ProjectConfig): Promise<BuildReport> {
  const metricsEnabled = isBuildMetricsEnabled();
  const totalStart = now();
  let effectiveConfig: ProjectConfig;
  try {
    effectiveConfig = resolveIntegrationConfig(config);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to resolve the selected integration.';
    return failure(config.outDir, [message]);
  }
  const analysis = analyzeProject({
    tsconfigPath: effectiveConfig.tsconfig,
    enforcePrivate: effectiveConfig.compiler.enforcePrivate,
  });

  if (analysis.tsDiagnostics.length > 0) {
    return failure(config.outDir, [
      ...analysis.tsDiagnostics.map((diagnostic) => formatTsDiagnostic(analysis.typescript, diagnostic)),
    ]);
  }

  // TypeScript never rewrites path aliases in the JavaScript it emits, so the contract
  // transformer rewrites each aliased specifier to a relative one at emit time (see
  // resolve-path-alias.ts) — this runs first to fail the build up front, with a precise
  // file:line pointer per occurrence, for any alias that cannot be turned into something
  // require()/import() can actually load (nothing on disk resolves it, or it resolves only to a
  // .d.ts with no runtime module behind it), instead of emitting JavaScript that would fail at
  // runtime with "Cannot find module" the first time that import path actually executes.
  const unresolvableAliases = findUnresolvableAliasedSpecifiers(analysis.typescript, analysis.program, isOutsideProject);
  if (unresolvableAliases.length > 0) {
    return failure(config.outDir, unresolvableAliases);
  }

  const entrySourceFile = analysis.program.getSourceFile(resolve(config.entry));
  if (entrySourceFile === undefined) {
    return failure(config.outDir, [`Entry file "${config.entry}" is not part of the TypeScript program.`]);
  }

  const compilerOptions = analysis.program.getCompilerOptions();
  const originalOutDir = resolve(compilerOptions.outDir ?? dirname(config.tsconfig));
  const stagingRoot = resolve(`${config.outDir}.ts-typed-build-${randomUUID()}`);
  await mkdir(stagingRoot, { recursive: true });

  let astTransformMs = 0;
  let jsEmissionMs = 0;
  let bundlingMs = 0;

  try {
    const transformDiagnostics: CoverageDiagnostic[] = [];
    let entryRecord: EmitFileRecord | undefined;
    let hadEmitError = false;

    for (const sourceFile of analysis.program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile || isOutsideProject(sourceFile.fileName)) {
        continue;
      }

      const records: EmitFileRecord[] = [];
      const transformer = createContractTransformer({
        analysis,
        runtimeModule: RUNTIME_PACKAGE,
        extraProperties: config.extraProperties,
        strictClass: config.compiler.strictClass,
        enforceReadonly: config.compiler.enforceReadonly,
        enforcePrivate: config.compiler.enforcePrivate,
        enforceClosedInstances: config.compiler.enforceClosedInstances,
        enforceMutationGuards: config.compiler.enforceMutationGuards,
        onDiagnostic: (diagnostic) => transformDiagnostics.push(diagnostic),
      });
      const emitStart = now();
      const emitResult = analysis.program.emit(
        sourceFile,
        (fileName, data) => {
          const relativePath = relative(originalOutDir, resolve(fileName));
          const destination = join(stagingRoot, relativePath);
          mkdirSync(dirname(destination), { recursive: true });
          writeFileSync(destination, data);
          records.push({ relativePath });
        },
        undefined,
        false,
        {
          before: metricsEnabled
            ? [withTransformTiming(transformer, (ms) => {
              astTransformMs += ms;
            })]
            : [transformer],
        },
      );
      jsEmissionMs += now() - emitStart;

      hadEmitError = hadEmitError || emitResult.emitSkipped;
      if (sourceFile === entrySourceFile) {
        entryRecord = records.find((record) => record.relativePath.endsWith('.js'));
      }
    }
    // The per-file emit() call above includes running the "before"
    // transformer; what was measured as jsEmissionMs is still the whole
    // call, so the transform time already counted within it is subtracted
    // out here to keep the two stages from double-counting the same span.
    jsEmissionMs = Math.max(0, jsEmissionMs - astTransformMs);

    if (hadEmitError || entryRecord === undefined) {
      return failure(config.outDir, ['Emit was skipped by the TypeScript compiler.']);
    }

    // Analysis-time diagnostics cover contracts that have no schema to
    // transform (e.g. decorated or private members), so they must be merged
    // with the transform-time ones or those warnings are silently dropped.
    const coverage = createCoverageReport(analysis.coverage, [...analysis.diagnostics, ...transformDiagnostics]);
    const mustFailOnUnsupported =
      config.compiler.onUnsupported === 'error' &&
      coverage.items.some((item) => item.status === 'unsupported');

    if (mustFailOnUnsupported) {
      return failure(
        config.outDir,
        [formatCoverageReport(coverage, dirname(config.tsconfig))],
        coverage,
      );
    }

    const copiedAssets: BuildAssetReport[] = [];
    for (const asset of config.assets) {
      const destination = join(stagingRoot, asset.to);
      await mkdir(dirname(destination), { recursive: true });
      await cp(asset.from, destination, { recursive: true });
      copiedAssets.push({ from: asset.from, to: asset.to });
    }

    let finalRoot = stagingRoot;
    let bundled = false;
    const externals: string[] = [];

    if (config.ncc.enabled) {
      const bundleStart = now();
      const bundledRoot = `${stagingRoot}.bundle`;
      await mkdir(bundledRoot, { recursive: true });
      const bundleResult = await bundleProject(join(stagingRoot, entryRecord.relativePath), {
        minify: config.ncc.minify,
        sourceMap: config.ncc.sourceMap,
        sourceMapRegister: config.ncc.sourceMapRegister,
        target: config.ncc.target,
        externals: config.ncc.externals,
        cache: config.ncc.cache,
        license: config.ncc.license,
        quiet: config.ncc.quiet,
        debugLog: config.ncc.debugLog,
      });

      await writeFileAsync(join(bundledRoot, 'index.js'), bundleResult.code);
      if (bundleResult.map !== undefined) {
        await writeFileAsync(join(bundledRoot, 'index.js.map'), bundleResult.map);
      }
      for (const [assetName, asset] of Object.entries(bundleResult.assets)) {
        const destination = join(bundledRoot, assetName);
        await mkdir(dirname(destination), { recursive: true });
        await writeFileAsync(destination, asset.source);
      }
      for (const asset of copiedAssets) {
        const destination = join(bundledRoot, asset.to);
        await mkdir(dirname(destination), { recursive: true });
        await cp(join(stagingRoot, asset.to), destination, { recursive: true });
      }

      externals.push(...config.ncc.externals);
      await rm(stagingRoot, { recursive: true, force: true });
      finalRoot = bundledRoot;
      bundled = true;
      bundlingMs = now() - bundleStart;
    }

    await replaceDirectory(finalRoot, config.outDir);

    const metrics = buildMetricsOrUndefined(
      metricsEnabled,
      analysis.internalTimingMs,
      astTransformMs,
      jsEmissionMs,
      bundlingMs,
      now() - totalStart,
    );

    return {
      success: true,
      outDir: config.outDir,
      bundled,
      coverage,
      assets: copiedAssets,
      externals,
      errors: [],
      ...(metrics === undefined ? {} : { metrics }),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown build error';
    return failure(config.outDir, [message]);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(`${stagingRoot}.bundle`, { recursive: true, force: true }).catch(() => undefined);
  }
}

function resolveIntegrationConfig(config: ProjectConfig): ProjectConfig {
  const projectRoot = dirname(config.tsconfig);
  const project = resolveProject(
    { projectRoot, configPath: config.tsconfig },
    config.integration,
  );
  return {
    ...config,
    tsconfig: project.configPath ?? config.tsconfig,
  };
}

function failure(
  outDir: string,
  errors: readonly string[],
  coverage?: BuildReport['coverage'],
): BuildReport {
  return {
    success: false,
    outDir,
    bundled: false,
    ...(coverage === undefined ? {} : { coverage }),
    assets: [],
    externals: [],
    errors,
  };
}

async function replaceDirectory(stagedDirectory: string, outDir: string): Promise<void> {
  const resolvedOutDir = resolve(outDir);
  const previousDirectory = existsSync(resolvedOutDir)
    ? `${resolvedOutDir}.ts-typed-previous-${randomUUID()}`
    : undefined;

  await mkdir(dirname(resolvedOutDir), { recursive: true });
  if (previousDirectory !== undefined) {
    await rename(resolvedOutDir, previousDirectory);
  }

  try {
    await rename(stagedDirectory, resolvedOutDir);
  } catch (error: unknown) {
    if (!isCrossDeviceError(error)) {
      if (previousDirectory !== undefined) {
        await rename(previousDirectory, resolvedOutDir);
      }
      throw error;
    }
    await cp(stagedDirectory, resolvedOutDir, { recursive: true });
  }

  if (previousDirectory !== undefined) {
    await rm(previousDirectory, { recursive: true, force: true });
  }
}

function isCrossDeviceError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EXDEV';
}

function withTransformTiming(
  factory: ts.TransformerFactory<ts.SourceFile>,
  onDuration: (ms: number) => void,
): ts.TransformerFactory<ts.SourceFile> {
  return (context) => {
    const transformer = factory(context);
    return (sourceFile) => {
      const start = now();
      const result = transformer(sourceFile);
      onDuration(now() - start);
      return result;
    };
  };
}

function buildMetricsOrUndefined(
  enabled: boolean,
  projectTiming: { readonly projectLoad: number; readonly typeAnalysis: number },
  astTransformMs: number,
  jsEmissionMs: number,
  bundlingMs: number,
  totalMs: number,
): BuildStageMetrics | undefined {
  if (!enabled) {
    return undefined;
  }
  const metrics: BuildStageMetrics = {
    projectLoad: projectTiming.projectLoad,
    typeAnalysis: projectTiming.typeAnalysis,
    astTransform: astTransformMs,
    jsEmission: jsEmissionMs,
    bundling: bundlingMs,
    total: totalMs,
  };
  console.error(formatBuildMetrics(metrics));
  return metrics;
}

function isOutsideProject(fileName: string): boolean {
  return fileName.includes('/node_modules/') || fileName.includes('\\node_modules\\');
}

function formatTsDiagnostic(
  typescript: typeof import('typescript'),
  diagnostic: import('typescript').Diagnostic,
): string {
  const message = typescript.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (diagnostic.file === undefined || diagnostic.start === undefined) {
    return message;
  }
  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1} ${message}`;
}
