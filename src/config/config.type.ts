import type {
  AssetConfig,
  CompilerConfig,
  DiagnosticsConfig,
  NccConfig,
  ProjectConfig,
} from './config.interface';

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends readonly (infer TItem)[]
    ? readonly TItem[]
    : T[P] extends object
      ? DeepPartial<T[P]>
      : T[P]
};

export type ConfigOverrides = DeepPartial<ProjectConfig>;

export type ConfigFragment = Partial<{
  $schema: string;
  integration: string;
  extends: string | null;
  entry: string;
  tsconfig: string;
  outDir: string;
  extraProperties: 'error' | 'strip';
  compiler: DeepPartial<CompilerConfig>;
  ncc: DeepPartial<NccConfig>;
  assets: readonly AssetConfig[];
  diagnostics: DeepPartial<DiagnosticsConfig>;
}>;
