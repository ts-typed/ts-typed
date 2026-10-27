import type { ObjectSchema } from './schema.interface';
import { getExtraPropertiesPolicy } from './extra-properties.decorator';
import { getTypeErrorResponse, type TypeErrorResponseOptions } from './type-error-response.decorator';
import type { Schema } from './schema.type';

export interface ObjectSchemaMetadata {
  readonly declaredKeys: readonly PropertyKey[];
  readonly declaredKeySet: ReadonlySet<PropertyKey>;
}

export interface ObjectProtectionProperty {
  readonly key: PropertyKey;
  readonly schema: Schema;
  readonly readonlyField: boolean;
  readonly pathSuffix: string;
  readonly extraPropertiesPolicy: 'error' | 'strip' | undefined;
  readonly typeErrorResponse: TypeErrorResponseOptions | undefined;
}

export interface ObjectProtectionInstaller {
  readonly properties: readonly ObjectProtectionProperty[];
}

/**
 * Caches static object-schema metadata for a single runtime traversal.
 *
 * A cache belongs to one validation/protection operation rather than the
 * registry, so metadata cannot survive into a later boundary crossing after
 * application code has replaced a schema definition. The WeakMap also does
 * not retain schema objects after the traversal completes.
 */
export class SchemaMetadataCache {
  private readonly _objectMetadata = new WeakMap<object, ObjectSchemaMetadata>();
  private readonly _objectInstallers = new WeakMap<
    object,
    WeakMap<object, ObjectProtectionInstaller>
  >();
  private readonly _nullPrototypeInstallers = new WeakMap<object, ObjectProtectionInstaller>();

  public getObjectMetadata(schema: ObjectSchema): ObjectSchemaMetadata {
    const existing = this._objectMetadata.get(schema);
    if (existing !== undefined) {
      return existing;
    }

    const declaredKeys = Reflect.ownKeys(schema.properties);
    const metadata: ObjectSchemaMetadata = {
      declaredKeys,
      declaredKeySet: new Set<PropertyKey>(declaredKeys),
    };
    this._objectMetadata.set(schema, metadata);
    return metadata;
  }

  public getObjectProtectionInstaller(
    schema: ObjectSchema,
    owner: object,
  ): ObjectProtectionInstaller {
    const prototype = Object.getPrototypeOf(owner) as object | null;
    if (prototype === null) {
      const existing = this._nullPrototypeInstallers.get(schema);
      if (existing !== undefined) {
        return existing;
      }
      const installer = this.createObjectProtectionInstaller(schema, owner);
      this._nullPrototypeInstallers.set(schema, installer);
      return installer;
    }

    const byPrototype = this._objectInstallers.get(schema) ?? new WeakMap<object, ObjectProtectionInstaller>();
    const existing = byPrototype.get(prototype);
    if (existing !== undefined) {
      return existing;
    }
    const installer = this.createObjectProtectionInstaller(schema, owner);
    byPrototype.set(prototype, installer);
    this._objectInstallers.set(schema, byPrototype);
    return installer;
  }

  private createObjectProtectionInstaller(
    schema: ObjectSchema,
    owner: object,
  ): ObjectProtectionInstaller {
    const properties = Reflect.ownKeys(schema.properties).map((key) => {
      const property = schema.properties[key];
      return Object.freeze({
        key,
        schema: property.schema,
        readonlyField: property.readonly === true,
        pathSuffix: typeof key === 'symbol' ? `[${String(key)}]` : `.${key}`,
        extraPropertiesPolicy: getExtraPropertiesPolicy(owner, decoratorPropertyKey(key)),
        typeErrorResponse: getTypeErrorResponse(owner, decoratorPropertyKey(key)),
      });
    });
    return Object.freeze({ properties: Object.freeze(properties) });
  }
}

function decoratorPropertyKey(key: PropertyKey): string | symbol {
  return typeof key === 'number' ? String(key) : key;
}
