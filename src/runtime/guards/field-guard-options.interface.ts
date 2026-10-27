export interface FieldGuardOptions {
  readonly initialized: boolean;
  readonly extraPropertiesPolicy?: 'error' | 'strip';
  /**
   * The field comes from a TypeScript `readonly` modifier and
   * `compiler.enforceReadonly` is active. Writes are still validated and
   * accepted normally — matching TypeScript's own rule that a `readonly`
   * field may be (re)assigned any number of times while its declaring
   * class's constructor is still running — until the compiler calls
   * {@link lockReadonlyField} at the end of that constructor. From then on,
   * every write attempt throws a `StrictTypeError` with code
   * `READONLY_PROPERTY` instead of silently overwriting the field.
   */
  readonly readonlyField?: boolean;
}
