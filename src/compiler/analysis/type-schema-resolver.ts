import type ts from 'typescript';

import type { ObjectPropertySchema, Schema } from '../../runtime';
import type { SchemaResolution } from './schema-resolution.interface';

const ALIAS_LIMIT_REASON =
  'The value is validated at the typed boundary, but mutations through external aliases can escape.';

const MAP_NAMES: ReadonlySet<string> = new Set(['Map', 'ReadonlyMap']);
const SET_NAMES: ReadonlySet<string> = new Set(['Set', 'ReadonlySet']);

/**
 * Path heuristic for the runtime `ValueObject` declaration. See
 * `_isValueObjectBase` for why this is a path check rather than package identity.
 */
function isValueObjectRuntimePath(fileName: string): boolean {
  const normalized = fileName.replace(/\\/g, '/');
  if (normalized.endsWith('/runtime/value-object.class.ts')) {
    return true;
  }
  return normalized.endsWith('/runtime/value-object.class.d.ts') && normalized.includes('/@ts-typed/core/');
}

/**
 * Path heuristic for the runtime `AggregateErrors` decorator declaration.
 * Same approach as `isValueObjectRuntimePath` above — a path check, not a
 * full package-identity check.
 */
function isAggregateErrorsRuntimePath(fileName: string): boolean {
  const normalized = fileName.replace(/\\/g, '/');
  if (normalized.endsWith('/runtime/aggregate-errors.decorator.ts')) {
    return true;
  }
  return (
    normalized.endsWith('/runtime/aggregate-errors.decorator.d.ts') &&
    normalized.includes('/@ts-typed/core/')
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when every declaration of a type's symbol lives inside some
 * `node_modules` package other than `@ts-typed/*` itself. Such a type (e.g.
 * NestJS's `ArgumentsHost`) is not authored by the user: they cannot add
 * `@AllowExtraProperties()` to someone else's interface, and the real
 * runtime object behind it is free to carry properties its public shape
 * never declares (internal fields like `args`/`container`). Validating it as
 * closed would reject every real instance, so it defaults to open instead.
 * `@ts-typed/*` packages are excluded because their own types are governed
 * by their dedicated rules (ValueObject, AggregateErrors, …) regardless of
 * whether they are consumed as project source or as an installed dependency.
 */
function isThirdPartyDeclaration(declarations: readonly ts.Declaration[]): boolean {
  if (declarations.length === 0) {
    return false;
  }
  return declarations.every((declaration) => {
    const normalized = declaration.getSourceFile().fileName.replace(/\\/g, '/');
    // `type.getSymbol()` on a `Partial<T>`/`Pick<T, K>`/`Record<K, V>` etc.
    // instantiation resolves to the generic utility type's OWN declaration in
    // TypeScript's bundled lib (`node_modules/typescript/lib/lib.es5.d.ts`),
    // not to any real third-party dependency; excluding that path keeps these
    // mapped types closed/structural as before.
    return (
      normalized.includes('/node_modules/') &&
      !normalized.includes('/node_modules/@ts-typed/') &&
      !normalized.includes('/node_modules/typescript/lib/')
    );
  });
}

interface CompoundResolution {
  readonly schema?: Schema;
  readonly status: 'protected' | 'partial' | 'unsupported';
  readonly reason?: string;
}

export class TypeSchemaResolver {
  private readonly _definitions = new Map<string, Schema>();
  private readonly _definitionNames = new Map<ts.Type, string>();
  private readonly _definitionResolutions = new Map<ts.Type, SchemaResolution>();
  private readonly _definitionTypes = new Map<string, ts.Type>();
  private readonly _resolvingDefinitions = new Set<ts.Type>();
  private readonly _classSymbolsByDefinitionName = new Map<string, ts.Symbol>();
  private readonly _valueObjectDefinitionNames = new Set<string>();
  private readonly _aggregateErrorsDefinitionNames = new Set<string>();

  public constructor(
    private readonly _typescript: typeof import('typescript'),
    private readonly _checker: ts.TypeChecker,
    private readonly _enforcePrivate: boolean = false,
  ) {}

  public resolve(type: ts.Type, node: ts.Node): SchemaResolution {
    const optimizedImmutableType = this._unwrapTTOptImmut(type);
    if (optimizedImmutableType !== undefined) {
      const unsupportedReason = this._findTTOptImmutUnsupportedReason(
        optimizedImmutableType,
        node,
        new Set<ts.Type>(),
      );
      if (unsupportedReason !== undefined) {
        return {
          status: 'unsupported',
          reason: `TTOptImmut cannot be used here: ${unsupportedReason}`,
          protectionStrategy: 'optimizedImmutable',
        };
      }
    }
    const resolution = this._resolveType(optimizedImmutableType ?? type, node, true);
    return optimizedImmutableType === undefined
      ? resolution
      : { ...resolution, protectionStrategy: 'optimizedImmutable' };
  }

  public getDefinitions(): Readonly<Record<string, Schema>> {
    return Object.freeze(Object.fromEntries(this._definitions));
  }

  /**
   * The class declaration symbol backing a named object definition, when
   * that definition's type originated from a class rather than an
   * interface/type alias. Used by the transformer to decide whether it can
   * embed a live `instanceof` reference for `compiler.strictClass`.
   */
  public getClassSymbol(definitionName: string): ts.Symbol | undefined {
    return this._classSymbolsByDefinitionName.get(definitionName);
  }

  /**
   * Whether a named object definition is backed by a class that extends the
   * `ValueObject` runtime base, directly or through any number of intermediate
   * subclasses. The transformer uses this to embed a live `valueObjectCtor`
   * reference so raw strings are auto-constructed into instances.
   */
  public isValueObjectClass(definitionName: string): boolean {
    return this._valueObjectDefinitionNames.has(definitionName);
  }

  /**
   * Whether a named object definition is backed by a class decorated with
   * `@AggregateErrors()`, directly or through any ancestor in its
   * base-class chain. Found by reading the decorator straight off the
   * class declaration via the type checker — unlike `getClassSymbol`'s
   * `instanceOf` use, this needs no live reference embedded at the
   * validation point, so it works regardless of which file the class is
   * declared in.
   */
  public isAggregateErrorsClass(definitionName: string): boolean {
    return this._aggregateErrorsDefinitionNames.has(definitionName);
  }

  /**
   * The public `TTOptImmut<T>` alias is a compile-time marker, not a runtime
   * schema node. Unwrap it only at the contract boundary (`resolve` above),
   * so an ordinary nested type alias cannot accidentally change how an outer
   * mutable contract is protected.
   */
  private _unwrapTTOptImmut(type: ts.Type): ts.Type | undefined {
    if (type.aliasSymbol?.getName() === 'TTOptImmut') {
      const [typeArgument] = type.aliasTypeArguments ?? [];
      if (typeArgument !== undefined) {
        return typeArgument;
      }
    }

    // TypeScript expands `TTOptImmut<T>` into an intersection when a consumer
    // gives it another alias (`type Users = TTOptImmut<User[]>`). The unique
    // symbol survives that expansion as an escaped property name, while the
    // generic alias itself does not. Remove only that marker constituent.
    if (!type.isIntersection()) {
      return undefined;
    }
    const markerIndex = type.types.findIndex((member) =>
      this._hasTTOptImmutBrand(member),
    );
    if (markerIndex === -1 || type.types.length !== 2) {
      return undefined;
    }
    return type.types[markerIndex === 0 ? 1 : 0];
  }

  private _hasTTOptImmutBrand(type: ts.Type): boolean {
    return this._checker.getPropertiesOfType(type).some((property) =>
      property.getName().startsWith('__@ttOptImmutBrand@'),
    );
  }

  /**
   * Detects `Int<Min,Max>`/`Float<Min,Max>`/`Str<MinLen,MaxLen>` (see
   * `runtime/ranged.type.ts`) by their `unique symbol` brand, the same
   * approach as `_hasTTOptImmutBrand` above. The bound literals are read
   * from the brand's own `bounds` tuple rather than from
   * `type.aliasTypeArguments`, so this also resolves correctly when a
   * consumer wraps the type in another alias (`type Age = Int<0, 150>`),
   * which erases `aliasTypeArguments` on the outer type but leaves the
   * intersection's brand member intact.
   */
  private _resolveRangedType(type: ts.Type): SchemaResolution | undefined {
    if (!type.isIntersection() || type.types.length !== 2) {
      return undefined;
    }
    for (const member of type.types) {
      const brand = this._rangedBrandOf(member);
      if (brand === undefined) {
        continue;
      }
      const base = type.types.find((candidate) => candidate !== member);
      if (base === undefined) {
        continue;
      }
      const resolution = this._resolveRangedBrand(brand, base);
      if (resolution !== undefined) {
        return resolution;
      }
    }
    return undefined;
  }

  private _rangedBrandOf(
    type: ts.Type,
  ): { readonly kind: 'int' | 'float' | 'str'; readonly bounds: readonly ts.Type[] } | undefined {
    const brandProperty = this._checker
      .getPropertiesOfType(type)
      .find((property) => property.getName().startsWith('__@ttRangedBrand@'));
    if (brandProperty === undefined) {
      return undefined;
    }
    // The brand field is declared optional (`[ttRangedBrand]?: {...}`) so its
    // own type carries `| undefined` once `strictNullChecks` is on.
    const brandType = this._checker.getNonNullableType(this._checker.getTypeOfSymbol(brandProperty));
    const brandProperties = this._checker.getPropertiesOfType(brandType);
    const kindProperty = brandProperties.find((property) => property.getName() === 'kind');
    const boundsProperty = brandProperties.find((property) => property.getName() === 'bounds');
    if (kindProperty === undefined || boundsProperty === undefined) {
      return undefined;
    }
    const kindType = this._checker.getTypeOfSymbol(kindProperty);
    if (!kindType.isStringLiteral()) {
      return undefined;
    }
    const kind = kindType.value;
    if (kind !== 'int' && kind !== 'float' && kind !== 'str') {
      return undefined;
    }
    const boundsType = this._checker.getTypeOfSymbol(boundsProperty);
    if (!this._checker.isTupleType(boundsType)) {
      return undefined;
    }
    return { kind, bounds: this._checker.getTypeArguments(boundsType as ts.TypeReference) };
  }

  /** A bound is "set" only when the argument is a literal; an omitted bound resolves to the plain `number` default. */
  private _rangedBoundLiteral(type: ts.Type | undefined): number | undefined {
    return type !== undefined && type.isNumberLiteral() ? type.value : undefined;
  }

  private _resolveRangedBrand(
    brand: { readonly kind: 'int' | 'float' | 'str'; readonly bounds: readonly ts.Type[] },
    base: ts.Type,
  ): SchemaResolution | undefined {
    const [minType, maxType] = brand.bounds;
    const min = this._rangedBoundLiteral(minType);
    const max = this._rangedBoundLiteral(maxType);
    const typeFlags = this._typescript.TypeFlags;

    if (min !== undefined && max !== undefined && min > max) {
      // An authoring mistake (`Int<150, 0>`), not a type-system limitation —
      // reuses the existing `onUnsupported` lever (default "warn", escalate
      // to "error" to hard-fail) instead of introducing a second, always-
      // fatal diagnostic channel that would conflict with the project's
      // warn-by-default compatibility policy (SPEC.md §6.2).
      return this._unsupported(`${brand.kind === 'str' ? 'Str' : brand.kind === 'int' ? 'Int' : 'Float'} has min (${min}) greater than max (${max}).`);
    }

    if (brand.kind === 'str') {
      if ((base.flags & typeFlags.String) === 0) {
        return undefined;
      }
      return {
        status: 'protected',
        schema: {
          kind: 'stringLength',
          ...(min !== undefined ? { minLength: min } : {}),
          ...(max !== undefined ? { maxLength: max } : {}),
        },
      };
    }
    if ((base.flags & typeFlags.Number) === 0) {
      return undefined;
    }
    return {
      status: 'protected',
      schema: {
        kind: 'numericConstraint',
        integer: brand.kind === 'int',
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
      },
    };
  }

  /**
   * `TTOptImmut` is deliberately narrower than regular structural contracts:
   * it promises native immutable POJOs, so a class, accessor-oriented builtin
   * or ambiguous compound contract must fail at build time instead of quietly
   * falling back to accessor guards.
   */
  private _findTTOptImmutUnsupportedReason(
    type: ts.Type,
    node: ts.Node,
    visited: Set<ts.Type>,
  ): string | undefined {
    if (visited.has(type)) {
      return undefined;
    }
    visited.add(type);
    if ((type.flags & (this._typescript.TypeFlags.Any | this._typescript.TypeFlags.Unknown)) !== 0) {
      return 'any and unknown do not describe a concrete immutable DTO shape.';
    }
    if ((type.flags & this._typescript.TypeFlags.NonPrimitive) !== 0) {
      return 'the broad object type does not describe a concrete immutable DTO shape.';
    }
    if (this._resolveDirectType(type) !== undefined) {
      return this._isGlobalDate(type) ? 'Date values are not plain DTO data.' : undefined;
    }
    if (type.isUnion() || type.isIntersection()) {
      return 'union and intersection contracts are ambiguous for the immutable DTO strategy.';
    }
    if (this._isPureFunction(type)) {
      return 'functions are not plain DTO data.';
    }
    if (this._checker.isTupleType(type) || this._checker.isArrayType(type)) {
      const itemTypes = this._checker.getTypeArguments(type as ts.TypeReference);
      for (const itemType of itemTypes) {
        const reason = this._findTTOptImmutUnsupportedReason(itemType, node, visited);
        if (reason !== undefined) {
          return reason;
        }
      }
      return undefined;
    }
    if (this._getGlobalCollectionKind(type) !== undefined) {
      return 'Map and Set values are not plain DTO data.';
    }
    if ((type.flags & this._typescript.TypeFlags.Object) === 0) {
      return `type ${this._checker.typeToString(type, node)} is not a plain DTO value.`;
    }
    if (this._getClassSymbol(type) !== undefined) {
      return 'class instances require normal typed protection so their mutable behavior remains valid.';
    }
    if (this._checker.getIndexInfosOfType(type).length > 0) {
      return 'indexed object contracts are not supported by the immutable DTO strategy.';
    }
    for (const property of this._checker.getPropertiesOfType(type)) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? node;
      const reason = this._findTTOptImmutUnsupportedReason(
        this._checker.getTypeOfSymbolAtLocation(property, declaration),
        declaration,
        visited,
      );
      if (reason !== undefined) {
        return `property ${property.getName()} is unsupported because ${reason}`;
      }
    }
    return undefined;
  }

  private _resolveType(type: ts.Type, node: ts.Node, canCreateDefinition: boolean): SchemaResolution {
    const rangedResolution = this._resolveRangedType(type);
    if (rangedResolution !== undefined) {
      return rangedResolution;
    }

    const directResolution = this._resolveDirectType(type);
    if (directResolution !== undefined) {
      return directResolution;
    }
    // A pure function type is an opaque leaf (see _isPureFunction) regardless
    // of WHERE it is being resolved from. _resolvePropertyType special-cases
    // this for a property being resolved as part of its containing object's
    // structural shape, but a function-typed value can also be its own
    // top-level contract — a class field's own candidate, a variable, a
    // parameter, a return — which reaches this general path directly, not
    // through _resolvePropertyType. Handling it here, before the Union
    // branch below, also means a union member that is a pure function (e.g.
    // `(() => void) | undefined`) gets the same leaf treatment through the
    // ordinary recursive _resolveComposite call, with no separate union
    // handling needed on this path.
    if (this._isPureFunction(type)) {
      return { status: 'protected', schema: { kind: 'function' } };
    }

    if (type.isUnion()) {
      return this._resolveDefinitionOrCompound(type, node, canCreateDefinition, () =>
        this._resolveComposite(type.types, node, 'union'),
      );
    }
    if (type.isIntersection()) {
      return this._resolveDefinitionOrCompound(type, node, canCreateDefinition, () =>
        this._resolveComposite(type.types, node, 'intersection'),
      );
    }
    if ((type.flags & this._typescript.TypeFlags.TypeParameter) !== 0) {
      return this._unsupported(
        `Generic type parameter ${this._checker.typeToString(type, node)} has no concrete runtime contract.`,
      );
    }
    if (this._checker.isTupleType(type)) {
      return this._resolveDefinitionOrCompound(type, node, canCreateDefinition, () =>
        this._resolveTuple(type, node),
      );
    }
    if (this._checker.isArrayType(type)) {
      return this._resolveDefinitionOrCompound(type, node, canCreateDefinition, () =>
        this._resolveArray(type, node),
      );
    }
    // Map/Set carry TypeFlags.Object like any interface, so they must be
    // detected here, before the generic structural branch below.
    const collectionKind = this._getGlobalCollectionKind(type);
    if (collectionKind === 'map') {
      return this._resolveDefinitionOrCompound(type, node, canCreateDefinition, () =>
        this._resolveMap(type, node),
      );
    }
    if (collectionKind === 'set') {
      return this._resolveDefinitionOrCompound(type, node, canCreateDefinition, () =>
        this._resolveSet(type, node),
      );
    }
    if ((type.flags & this._typescript.TypeFlags.Object) !== 0) {
      return this._resolveDefinitionOrCompound(type, node, canCreateDefinition, () =>
        this._resolveObject(type, node),
      );
    }

    return this._unsupported(
      `Type ${this._checker.typeToString(type, node)} cannot be represented by the runtime schema model.`,
    );
  }

  private _resolveDirectType(type: ts.Type): SchemaResolution | undefined {
    const flags = type.flags;
    const typeFlags = this._typescript.TypeFlags;

    if ((flags & typeFlags.Any) !== 0) {
      return { status: 'open', schema: { kind: 'unknown' }, reason: 'The effective contract is any.' };
    }
    if ((flags & typeFlags.Unknown) !== 0) {
      return {
        status: 'open',
        schema: { kind: 'unknown' },
        reason: 'The effective contract is unknown.',
      };
    }
    if ((flags & typeFlags.Never) !== 0) {
      return { status: 'protected', schema: { kind: 'never' } };
    }
    if (type.isStringLiteral()) {
      return { status: 'protected', schema: { kind: 'literal', value: type.value } };
    }
    if (type.isNumberLiteral()) {
      return { status: 'protected', schema: { kind: 'literal', value: type.value } };
    }
    if ((flags & typeFlags.BooleanLiteral) !== 0) {
      const booleanValue = this._checker.typeToString(type) === 'true';
      return { status: 'protected', schema: { kind: 'literal', value: booleanValue } };
    }
    if ((flags & typeFlags.BigIntLiteral) !== 0) {
      const valueText = this._checker.typeToString(type).replace(/n$/, '');
      return { status: 'protected', schema: { kind: 'literal', value: BigInt(valueText) } };
    }
    if ((flags & typeFlags.UniqueESSymbol) !== 0) {
      return this._unsupported('Unique symbol identity cannot be represented by the runtime schema model.');
    }
    if ((flags & typeFlags.String) !== 0) {
      return { status: 'protected', schema: { kind: 'primitive', name: 'string' } };
    }
    if ((flags & typeFlags.Number) !== 0) {
      return { status: 'protected', schema: { kind: 'primitive', name: 'number' } };
    }
    if ((flags & typeFlags.Boolean) !== 0) {
      return { status: 'protected', schema: { kind: 'primitive', name: 'boolean' } };
    }
    if ((flags & typeFlags.BigInt) !== 0) {
      return { status: 'protected', schema: { kind: 'primitive', name: 'bigint' } };
    }
    if ((flags & typeFlags.ESSymbol) !== 0) {
      return { status: 'protected', schema: { kind: 'primitive', name: 'symbol' } };
    }
    if ((flags & typeFlags.Null) !== 0) {
      return { status: 'protected', schema: { kind: 'literal', value: null } };
    }
    if ((flags & (typeFlags.Undefined | typeFlags.Void)) !== 0) {
      return { status: 'protected', schema: { kind: 'literal', value: undefined } };
    }
    if ((flags & typeFlags.NonPrimitive) !== 0) {
      return { status: 'protected', schema: { kind: 'primitive', name: 'object' } };
    }
    if (this._isGlobalDate(type)) {
      // Date is an opaque leaf: its methods are never enumerated (they are
      // callable and would otherwise poison the whole object contract).
      return { status: 'protected', schema: { kind: 'date' } };
    }
    if ((flags & typeFlags.TemplateLiteral) !== 0) {
      return this._resolveTemplateLiteral(type as ts.TemplateLiteralType);
    }

    return undefined;
  }

  /**
   * Open template literal types (`${number}px`, `user_${string}`) are leaves
   * validated by a regex compiled from their texts and placeholders. Finite
   * interpolations (`${'a' | 'b'}`) never reach here: TypeScript already
   * expands them into a union of string literals.
   */
  private _resolveTemplateLiteral(type: ts.TemplateLiteralType): SchemaResolution {
    const pattern = this._templateLiteralPattern(type);
    if (pattern === undefined) {
      return this._unsupported(
        `Template literal type ${this._checker.typeToString(type)} has a placeholder with no runtime pattern.`,
      );
    }
    return { status: 'protected', schema: { kind: 'templateLiteral', pattern } };
  }

  private _templateLiteralPattern(type: ts.TemplateLiteralType): string | undefined {
    const placeholderPatterns: string[] = [];
    for (const placeholder of type.types) {
      const placeholderPattern = this._placeholderPattern(placeholder);
      if (placeholderPattern === undefined) {
        return undefined;
      }
      placeholderPatterns.push(placeholderPattern);
    }

    let pattern = '^';
    type.texts.forEach((text, index) => {
      pattern += escapeRegExp(text);
      if (index < placeholderPatterns.length) {
        pattern += placeholderPatterns[index];
      }
    });
    return `${pattern}$`;
  }

  private _placeholderPattern(placeholder: ts.Type): string | undefined {
    const typeFlags = this._typescript.TypeFlags;
    if ((placeholder.flags & typeFlags.String) !== 0) {
      // Any string, including the empty one. `[\s\S]` also matches newlines.
      return '[\\s\\S]*';
    }
    if ((placeholder.flags & typeFlags.Number) !== 0) {
      // Integers and plain decimals only; exponent notation, `Infinity` and
      // `NaN` are not covered (documented limitation).
      return '-?\\d+(?:\\.\\d+)?';
    }
    if ((placeholder.flags & typeFlags.BigInt) !== 0) {
      return '-?\\d+';
    }
    if ((placeholder.flags & typeFlags.Boolean) !== 0) {
      return '(?:true|false)';
    }
    if (placeholder.isStringLiteral() || placeholder.isNumberLiteral()) {
      return escapeRegExp(String(placeholder.value));
    }
    if (placeholder.isUnion()) {
      const alternatives = placeholder.types.map((member) => this._placeholderPattern(member));
      if (alternatives.some((alternative) => alternative === undefined)) {
        return undefined;
      }
      return `(?:${alternatives.join('|')})`;
    }
    return undefined;
  }

  /**
   * Heuristic: the built-in `Date` interface is declared in a TypeScript lib
   * file, which carries `/// <reference no-default-lib="true"/>` and therefore
   * `hasNoDefaultLib === true`. A user-declared class/interface named `Date`
   * lives in an ordinary module and is not matched.
   */
  /**
   * Resolves the type of an object property. A property whose type is purely a
   * function (or such a function optionally widened with `undefined`/`null`, as
   * in `onClick?: () => void`) is an opaque `function` leaf, so one callback field
   * does not make the whole containing object unsupported. Any other shape goes
   * through the general resolution unchanged.
   */
  private _resolvePropertyType(type: ts.Type, declaration: ts.Node): SchemaResolution {
    const members = type.isUnion() ? type.types : [type];
    const functionMembers = members.filter((member) => this._isPureFunction(member));
    if (functionMembers.length === 0) {
      return this._resolveType(type, declaration, true);
    }
    const typeFlags = this._typescript.TypeFlags;
    const schemas: Schema[] = [];
    for (const member of members) {
      if (this._isPureFunction(member)) {
        schemas.push({ kind: 'function' });
      } else if ((member.flags & typeFlags.Undefined) !== 0) {
        schemas.push({ kind: 'literal', value: undefined });
      } else if ((member.flags & typeFlags.Null) !== 0) {
        schemas.push({ kind: 'literal', value: null });
      } else {
        // Mixed with a non-function member: not a pure function leaf.
        return this._resolveType(type, declaration, true);
      }
    }
    return {
      status: 'protected',
      schema: schemas.length === 1 ? schemas[0] : { kind: 'union', schemas },
    };
  }

  private _isClassMethod(property: ts.Symbol): boolean {
    return (property.declarations ?? []).some(
      (declaration) =>
        this._typescript.isMethodDeclaration(declaration) && this._typescript.isClassLike(declaration.parent),
    );
  }

  /**
   * Heuristic: a type is "purely a function" when it has call signatures, no
   * construct signatures, and no own members at all. `getPropertiesOfType` does
   * not include the members inherited from the global `Function` interface
   * (`call`, `apply`, `bind`, `name`, ...), which are reached through the apparent
   * type, so an empty property list means no user-declared extras. Index
   * signatures are checked too, since they are also extra structure. Anything
   * with extra members (`{ (): void; extra: string }`) stays unsupported.
   */
  private _isPureFunction(type: ts.Type): boolean {
    return (
      type.getCallSignatures().length > 0 &&
      type.getConstructSignatures().length === 0 &&
      this._checker.getPropertiesOfType(type).length === 0 &&
      this._checker.getIndexInfosOfType(type).length === 0
    );
  }

  private _isGlobalDate(type: ts.Type): boolean {
    const symbol = type.getSymbol();
    if (symbol === undefined || symbol.getName() !== 'Date') {
      return false;
    }
    return (symbol.getDeclarations() ?? []).some(
      (declaration) => declaration.getSourceFile().hasNoDefaultLib,
    );
  }

  /**
   * Same heuristic as {@link _isGlobalDate}: the built-in collection interfaces
   * live in TypeScript lib files (`hasNoDefaultLib === true`), so a user type
   * that merely shares a name is not matched. `WeakMap`/`WeakSet` are
   * deliberately out of scope and stay unsupported.
   */
  private _getGlobalCollectionKind(type: ts.Type): 'map' | 'set' | undefined {
    const symbol = type.getSymbol();
    if (symbol === undefined) {
      return undefined;
    }
    const name = symbol.getName();
    const kind = MAP_NAMES.has(name) ? 'map' : SET_NAMES.has(name) ? 'set' : undefined;
    if (kind === undefined) {
      return undefined;
    }
    const isLibDeclaration = (symbol.getDeclarations() ?? []).some(
      (declaration) => declaration.getSourceFile().hasNoDefaultLib,
    );
    return isLibDeclaration ? kind : undefined;
  }

  private _resolveDefinitionOrCompound(
    type: ts.Type,
    node: ts.Node,
    canCreateDefinition: boolean,
    resolveCompound: () => CompoundResolution,
  ): SchemaResolution {
    const definitionName = canCreateDefinition ? this._getDefinitionName(type, node) : undefined;
    if (definitionName === undefined) {
      return resolveCompound();
    }
    if (this._resolvingDefinitions.has(type)) {
      return { status: 'partial', schema: { kind: 'ref', name: definitionName }, reason: ALIAS_LIMIT_REASON };
    }
    const cachedResolution = this._definitionResolutions.get(type);
    if (cachedResolution !== undefined) {
      return {
        status: cachedResolution.status,
        schema: { kind: 'ref', name: definitionName },
        ...(cachedResolution.reason === undefined ? {} : { reason: cachedResolution.reason }),
      };
    }

    this._resolvingDefinitions.add(type);
    const resolvedDefinition = resolveCompound();
    this._resolvingDefinitions.delete(type);
    if (resolvedDefinition.schema === undefined || resolvedDefinition.status === 'unsupported') {
      this._definitionNames.delete(type);
      this._definitionTypes.delete(definitionName);
      return resolvedDefinition;
    }

    const resolution: SchemaResolution = {
      status: resolvedDefinition.status,
      schema: { kind: 'ref', name: definitionName },
      ...(resolvedDefinition.reason === undefined ? {} : { reason: resolvedDefinition.reason }),
    };
    this._definitions.set(definitionName, resolvedDefinition.schema);
    const classSymbol = this._getClassSymbol(type);
    if (classSymbol !== undefined) {
      this._classSymbolsByDefinitionName.set(definitionName, classSymbol);
      if (this._isValueObjectType(type)) {
        this._valueObjectDefinitionNames.add(definitionName);
      }
      if (this._isAggregateErrorsType(type)) {
        this._aggregateErrorsDefinitionNames.add(definitionName);
      }
    }
    this._definitionResolutions.set(type, resolution);
    return resolution;
  }

  private _resolveComposite(
    members: readonly ts.Type[],
    node: ts.Node,
    kind: 'union' | 'intersection',
  ): CompoundResolution {
    const resolutions = members.map((member) => this._resolveType(member, node, true));
    const unsupported = resolutions.find((resolution) => resolution.schema === undefined);
    if (unsupported !== undefined) {
      return this._unsupported(
        `${kind === 'union' ? 'Union' : 'Intersection'} member is unsupported: ${unsupported.reason ?? 'unknown type limit'}`,
      );
    }
    const resolvedSchemas = resolutions.flatMap((resolution) =>
      resolution.schema === undefined ? [] : [resolution.schema],
    );
    const schemas =
      kind === 'intersection'
        ? resolvedSchemas.map((schema) => this._expandIntersectionObjectReference(schema))
        : resolvedSchemas;
    const isPartial = resolutions.some((resolution) => resolution.status === 'partial');
    return {
      status: isPartial ? 'partial' : 'protected',
      schema: { kind, schemas },
      ...(isPartial ? { reason: ALIAS_LIMIT_REASON } : {}),
    };
  }

  private _expandIntersectionObjectReference(schema: Schema): Schema {
    if (schema.kind !== 'ref') {
      return schema;
    }
    const definition = this._definitions.get(schema.name);
    return definition?.kind === 'object' ? definition : schema;
  }

  private _resolveTuple(type: ts.Type, node: ts.Node): CompoundResolution {
    const tupleReference = type as ts.TupleTypeReference;
    const elementFlags = tupleReference.target.elementFlags;
    if (elementFlags.some((flag) => (flag & this._typescript.ElementFlags.Optional) !== 0)) {
      return this._unsupported('Optional tuple positions are not represented by the runtime schema model.');
    }

    const typeArguments = this._checker.getTypeArguments(tupleReference);
    const restIndex = elementFlags.findIndex(
      (flag) => (flag & (this._typescript.ElementFlags.Rest | this._typescript.ElementFlags.Variadic)) !== 0,
    );
    const fixedTypes = restIndex === -1 ? typeArguments : typeArguments.slice(0, restIndex);
    const fixedResolutions = fixedTypes.map((itemType) => this._resolveType(itemType, node, true));
    const restResolution =
      restIndex === -1 ? undefined : this._resolveType(typeArguments[restIndex], node, true);
    const unsupported = [...fixedResolutions, ...(restResolution === undefined ? [] : [restResolution])].find(
      (resolution) => resolution.schema === undefined,
    );
    if (unsupported !== undefined) {
      return this._unsupported(`Tuple item is unsupported: ${unsupported.reason ?? 'unknown type limit'}`);
    }

    const items = fixedResolutions.flatMap((resolution) =>
      resolution.schema === undefined ? [] : [resolution.schema],
    );
    return {
      status: 'partial',
      schema: {
        kind: 'tuple',
        items,
        ...(restResolution?.schema === undefined ? {} : { rest: restResolution.schema }),
      },
      reason: ALIAS_LIMIT_REASON,
    };
  }

  private _resolveArray(type: ts.Type, node: ts.Node): CompoundResolution {
    const typeReference = type as ts.TypeReference;
    const itemType = this._checker.getTypeArguments(typeReference)[0];
    if (itemType === undefined) {
      return this._unsupported('Array element type could not be determined.');
    }
    const itemResolution = this._resolveType(itemType, node, true);
    if (itemResolution.schema === undefined) {
      return this._unsupported(
        `Array element is unsupported: ${itemResolution.reason ?? 'unknown type limit'}`,
      );
    }
    return {
      status: 'partial',
      schema: { kind: 'array', items: itemResolution.schema },
      reason: ALIAS_LIMIT_REASON,
    };
  }

  /**
   * `Map<K, V>` and `ReadonlyMap<K, V>`: both key and value are resolved and
   * validated per entry. Mutations through `.set()` after validation are not
   * intercepted (see guards.ts).
   */
  private _resolveMap(type: ts.Type, node: ts.Node): CompoundResolution {
    const [keyType, valueType] = this._checker.getTypeArguments(type as ts.TypeReference);
    if (keyType === undefined || valueType === undefined) {
      return this._unsupported('Map key and value types could not be determined.');
    }
    const keyResolution = this._resolveType(keyType, node, true);
    if (keyResolution.schema === undefined) {
      return this._unsupported(`Map key is unsupported: ${keyResolution.reason ?? 'unknown type limit'}`);
    }
    const valueResolution = this._resolveType(valueType, node, true);
    if (valueResolution.schema === undefined) {
      return this._unsupported(`Map value is unsupported: ${valueResolution.reason ?? 'unknown type limit'}`);
    }
    return {
      status: 'partial',
      schema: { kind: 'map', key: keyResolution.schema, value: valueResolution.schema },
      reason: ALIAS_LIMIT_REASON,
    };
  }

  /**
   * `Set<T>` and `ReadonlySet<T>`: each item is resolved and validated.
   * Mutations through `.add()` after validation are not intercepted.
   */
  private _resolveSet(type: ts.Type, node: ts.Node): CompoundResolution {
    const [itemType] = this._checker.getTypeArguments(type as ts.TypeReference);
    if (itemType === undefined) {
      return this._unsupported('Set item type could not be determined.');
    }
    const itemResolution = this._resolveType(itemType, node, true);
    if (itemResolution.schema === undefined) {
      return this._unsupported(`Set item is unsupported: ${itemResolution.reason ?? 'unknown type limit'}`);
    }
    return {
      status: 'partial',
      schema: { kind: 'set', item: itemResolution.schema },
      reason: ALIAS_LIMIT_REASON,
    };
  }

  private _resolveObject(type: ts.Type, node: ts.Node): CompoundResolution {
    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
      return this._unsupported('Callable and constructable contracts are not represented by object schemas.');
    }
    // A ValueObject subclass is validated by identity (`instanceof` against its
    // constructor), never by its members. Its own methods and the inherited
    // String members are therefore not walked as properties at all.
    if (this._isValueObjectType(type)) {
      return {
        status: 'partial',
        schema: { kind: 'object', properties: {} },
        reason: ALIAS_LIMIT_REASON,
      };
    }

    // A class reference is validated the same as any other structural object
    // schema: old-style `private`/`protected` members have no runtime effect
    // (erased by TypeScript) and are reflectively indistinguishable from
    // public fields. Only a true ECMAScript `#private` field is genuinely
    // opaque to the runtime: it has no property key reachable through
    // Reflect, so it cannot be represented or validated structurally.
    const propertyEntries: Array<readonly [string, ObjectPropertySchema]> = [];
    for (const property of this._checker.getPropertiesOfType(type)) {
      const propertyName = property.getName();
      if (propertyName.startsWith('__@')) {
        return this._unsupported('Symbol-named properties cannot be represented with stable runtime identity.');
      }
      if (propertyName.startsWith('#')) {
        return this._unsupported(
          'True #private class fields have no reflective runtime access and cannot be represented by the runtime schema model.',
        );
      }
      if (this._isConvertedToHashPrivate(property)) {
        // With enforcePrivate, the transformer rewrites this field into a real
        // `#private` field, so it has no reflective property at runtime and
        // must not be required by the structural schema. Only this member is
        // omitted; the rest of the class stays validated.
        continue;
      }
      if (this._isClassMethod(property)) {
        // Class methods keep the established contract: a class with a method is
        // not represented structurally. Only non-method members (fields holding
        // callbacks, interface method signatures) become function leaves.
        return this._unsupported(
          `Property ${propertyName} is unsupported: Callable and constructable contracts are not represented by object schemas.`,
        );
      }
      const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? node;
      const propertyType = this._checker.getTypeOfSymbolAtLocation(property, declaration);
      const propertyResolution = this._resolvePropertyType(propertyType, declaration);
      if (propertyResolution.schema === undefined) {
        return this._unsupported(
          `Property ${propertyName} is unsupported: ${propertyResolution.reason ?? 'unknown type limit'}`,
        );
      }
      propertyEntries.push([
        propertyName,
        {
          schema: propertyResolution.schema,
          ...((property.flags & this._typescript.SymbolFlags.Optional) === 0
            ? {}
            : { optional: true }),
          ...(this._hasDefiniteAssignmentAssertion(property)
            ? { optional: true, deferredAssignment: true }
            : {}),
          ...(this._isReadonlyPropertySignature(property) ? { readonly: true } : {}),
        },
      ]);
    }

    const indexInfos = this._checker.getIndexInfosOfType(type);
    if (indexInfos.length > 1) {
      return this._unsupported(
        'Multiple index signatures cannot be represented because the runtime schema has one index contract.',
      );
    }
    const indexResolution =
      indexInfos.length === 0 ? undefined : this._resolveType(indexInfos[0].type, node, true);
    if (indexResolution !== undefined && indexResolution.schema === undefined) {
      return this._unsupported(
        `Index signature is unsupported: ${indexResolution.reason ?? 'unknown type limit'}`,
      );
    }

    const hasIndex = indexResolution?.schema !== undefined;
    // Only the type's own symbol is checked, never `type.aliasSymbol`: for
    // `Partial<IUser>`/`Pick<IUser, ...>`/`Record<...>` etc., the alias symbol
    // is TypeScript's own built-in generic (declared in `node_modules/typescript/lib/*.d.ts`),
    // which would wrongly look third-party and open up every mapped-type usage.
    const typeSymbol = type.getSymbol();
    const isThirdParty =
      typeSymbol !== undefined && isThirdPartyDeclaration(typeSymbol.getDeclarations() ?? []);
    return {
      status: 'partial',
      schema: {
        kind: 'object',
        properties: Object.fromEntries(propertyEntries),
        ...(hasIndex ? { index: indexResolution.schema } : {}),
        ...(isThirdParty ? { allowExtraProperties: true } : {}),
      },
      reason: hasIndex
        ? `${ALIAS_LIMIT_REASON} The single runtime index contract does not distinguish string and symbol keys.`
        : ALIAS_LIMIT_REASON,
    };
  }

  /**
   * True only for a `readonly` member of an interface or type literal
   * (`ts.PropertySignature`). Class fields are deliberately excluded: they are
   * covered by `enforceReadonly`, which locks them after construction.
   * Known limitation: a `readonly` introduced by a mapped type such as
   * `Readonly<T>` is not detected, because the mapped symbol's value declaration
   * is the original (mutable) member.
   */
  private _isReadonlyPropertySignature(property: ts.Symbol): boolean {
    const declaration = property.valueDeclaration;
    if (declaration === undefined || !this._typescript.isPropertySignature(declaration)) {
      return false;
    }
    return (
      (this._typescript.getCombinedModifierFlags(declaration) & this._typescript.ModifierFlags.Readonly) !== 0
    );
  }

  /**
   * Mirrors the transformer's `isOnlyPrivateField` rule: with enforcePrivate,
   * a plain `private` PropertyDeclaration with an identifier name (not
   * protected, not static) is converted to a real `#private` field. Parameter
   * properties are not converted and remain part of the schema.
   */
  private _isConvertedToHashPrivate(property: ts.Symbol): boolean {
    if (!this._enforcePrivate) {
      return false;
    }
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (declaration === undefined || !this._typescript.isPropertyDeclaration(declaration)) {
      return false;
    }
    if (!this._typescript.isIdentifier(declaration.name)) {
      return false;
    }
    const flags = this._typescript.getCombinedModifierFlags(declaration);
    return (flags & this._typescript.ModifierFlags.Private) !== 0 &&
      (flags & (this._typescript.ModifierFlags.Protected | this._typescript.ModifierFlags.Static)) === 0;
  }

  private _getDefinitionName(type: ts.Type, node: ts.Node): string | undefined {
    const existingName = this._definitionNames.get(type);
    if (existingName !== undefined) {
      return existingName;
    }
    const symbol = type.aliasSymbol ?? type.getSymbol();
    if (symbol === undefined || symbol.getName().startsWith('__')) {
      return undefined;
    }
    const declarations = symbol.getDeclarations();
    if (declarations === undefined || declarations.length === 0) {
      return undefined;
    }
    const candidate = this._checker.typeToString(
      type,
      node,
      this._typescript.TypeFormatFlags.NoTruncation,
    );
    let definitionName = candidate;
    let collisionIndex = 2;
    while (
      this._definitionTypes.has(definitionName) &&
      this._definitionTypes.get(definitionName) !== type
    ) {
      definitionName = `${candidate}#${collisionIndex}`;
      collisionIndex += 1;
    }
    this._definitionNames.set(type, definitionName);
    this._definitionTypes.set(definitionName, type);
    return definitionName;
  }

  private _hasDefiniteAssignmentAssertion(property: ts.Symbol): boolean {
    // A class field declared with a definite assignment assertion (`field!:
    // T`, e.g. Angular-style `@Input() value!: T`) explicitly tells
    // TypeScript "this is not assigned yet here, trust me" — the compiler
    // does not verify it is set by the constructor. Treating it as required
    // in the structural schema would reject `new SomeClass()` the instant
    // it is constructed, before the caller has had a chance to assign it,
    // defeating that well-established, intentional pattern. The field stays
    // fully protected: `installFieldGuard` still validates whatever value is
    // eventually written to it.
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    return declaration !== undefined
      && this._typescript.isPropertyDeclaration(declaration)
      && declaration.exclamationToken !== undefined;
  }

  private _getClassSymbol(type: ts.Type): ts.Symbol | undefined {
    const symbol = type.getSymbol();
    const hasClassDeclaration = symbol
      ?.getDeclarations()
      ?.some((declaration) => this._typescript.isClassDeclaration(declaration)) === true;
    return hasClassDeclaration ? symbol : undefined;
  }

  /**
   * True when the class type has `ValueObject` somewhere in its base-class
   * chain. Walks every ancestor, not just the immediate parent. The `visited`
   * set only guards against a malformed cycle; valid TypeScript cannot produce
   * one, so there is no artificial depth limit.
   */
  private _isValueObjectType(type: ts.Type): boolean {
    return this._extendsValueObject(type, new Set<ts.Type>());
  }

  private _extendsValueObject(type: ts.Type, visited: Set<ts.Type>): boolean {
    if (visited.has(type) || !type.isClassOrInterface()) {
      return false;
    }
    visited.add(type);
    for (const baseType of this._checker.getBaseTypes(type)) {
      if (this._isValueObjectBase(baseType) || this._extendsValueObject(baseType, visited)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Provenance check for the `ValueObject` base itself. The name alone is not
   * trusted: a user class named `ValueObject` must not match. The declaration
   * must be a class in this package's runtime file. This package's own source
   * (`runtime/value-object.class.ts`) or its installed declaration
   * (`runtime/value-object.class.d.ts` under `@ts-typed/core/`) both match.
   * This is a path heuristic, not a full package-identity check.
   */
  private _isValueObjectBase(baseType: ts.Type): boolean {
    const symbol = baseType.getSymbol();
    if (symbol === undefined || symbol.getName() !== 'ValueObject') {
      return false;
    }
    return (symbol.getDeclarations() ?? []).some(
      (declaration) =>
        this._typescript.isClassDeclaration(declaration) &&
        isValueObjectRuntimePath(declaration.getSourceFile().fileName),
    );
  }

  /**
   * True when the class type (or any ancestor in its base-class chain)
   * carries `@AggregateErrors()`. Mirrors `_isValueObjectType`'s walk, but
   * checks each level's class declaration for the decorator instead of
   * checking base-type identity against a single known class.
   */
  private _isAggregateErrorsType(type: ts.Type): boolean {
    return this._hasAggregateErrorsDecorator(type, new Set<ts.Type>());
  }

  private _hasAggregateErrorsDecorator(type: ts.Type, visited: Set<ts.Type>): boolean {
    // An instantiated generic (`Dto<number>`) is a `TypeReference`, not
    // directly a class/interface type, so `isClassOrInterface()` would
    // otherwise always be false for it — unwrap to the underlying generic
    // declaration's type first. This also fixes inheritance detection for
    // `class Derived extends Base<number> {}`, since `getBaseTypes` on
    // `Derived` likewise yields a `TypeReference` for `Base<number>`.
    const resolvedType =
      (type.flags & this._typescript.TypeFlags.Object) !== 0 &&
      ((type as ts.ObjectType).objectFlags & this._typescript.ObjectFlags.Reference) !== 0
        ? (type as ts.TypeReference).target
        : type;

    if (visited.has(resolvedType) || !resolvedType.isClassOrInterface()) {
      return false;
    }
    visited.add(resolvedType);
    const symbol = resolvedType.getSymbol();
    const ownDeclarations = symbol?.getDeclarations() ?? [];
    const decoratedHere = ownDeclarations.some(
      (declaration) =>
        this._typescript.isClassDeclaration(declaration) &&
        this._classDeclarationHasAggregateErrors(declaration),
    );
    if (decoratedHere) {
      return true;
    }
    for (const baseType of this._checker.getBaseTypes(resolvedType)) {
      if (this._hasAggregateErrorsDecorator(baseType, visited)) {
        return true;
      }
    }
    return false;
  }

  private _classDeclarationHasAggregateErrors(declaration: ts.ClassDeclaration): boolean {
    const decorators = this._typescript.getDecorators(declaration) ?? [];
    return decorators.some((decorator) => this._isAggregateErrorsDecoratorCall(decorator.expression));
  }

  /**
   * Provenance check for the decorator call itself: the callee identifier
   * must resolve (via the checker) to this package's own
   * `runtime/aggregate-errors.decorator.ts` `AggregateErrors` function, not
   * just any same-named function a consumer happened to write themselves —
   * same reasoning as `_isValueObjectBase`'s path heuristic above.
   */
  private _isAggregateErrorsDecoratorCall(expression: ts.Expression): boolean {
    if (!this._typescript.isCallExpression(expression) || !this._typescript.isIdentifier(expression.expression)) {
      return false;
    }
    const declarations = this._resolveAliasedDeclarations(
      this._checker.getSymbolAtLocation(expression.expression),
    );
    return declarations.some(
      (declaration) =>
        this._typescript.isFunctionDeclaration(declaration) &&
        declaration.name?.text === 'AggregateErrors' &&
        isAggregateErrorsRuntimePath(declaration.getSourceFile().fileName),
    );
  }

  /**
   * `getSymbolAtLocation` on an identifier that names an imported binding
   * returns the local import/export-specifier symbol, not the declaration it
   * ultimately refers to — and a package re-exporting through a barrel file
   * (as this one does: `dist/index.d.ts` re-exporting from
   * `./runtime/aggregate-errors.decorator`) can chain more than one such
   * alias. This follows the chain all the way to the real declaration(s),
   * same as TypeScript's own "go to definition" does.
   */
  private _resolveAliasedDeclarations(symbol: ts.Symbol | undefined): readonly ts.Declaration[] {
    // `getAliasedSymbol` already follows an entire alias chain in one call —
    // it returns a non-aliased symbol, or the checker's own `unknownSymbol`
    // sentinel (which carries no `Alias` flag) when it cannot resolve
    // further — so a single resolution step is enough; it never leaves an
    // `Alias`-flagged symbol behind to iterate on again.
    let current = symbol;
    if (current !== undefined && (current.flags & this._typescript.SymbolFlags.Alias) !== 0) {
      current = this._checker.getAliasedSymbol(current);
    }
    return current?.getDeclarations() ?? [];
  }

  private _unsupported(reason: string): SchemaResolution & { readonly status: 'unsupported' } {
    return { status: 'unsupported', reason };
  }
}
