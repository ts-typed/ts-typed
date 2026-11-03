import type ts from 'typescript';

import type { Schema } from '../../runtime';

export function createSchemaExpression(
  typescript: typeof import('typescript'),
  factory: ts.NodeFactory,
  schema: Schema,
): ts.Expression {
  const properties: ts.ObjectLiteralElementLike[] = [
    factory.createPropertyAssignment('kind', factory.createStringLiteral(schema.kind)),
  ];

  switch (schema.kind) {
    case 'primitive':
      properties.push(factory.createPropertyAssignment('name', factory.createStringLiteral(schema.name)));
      break;
    case 'literal':
      properties.push(
        factory.createPropertyAssignment(
          'value',
          createLiteralExpression(typescript, factory, schema.value),
        ),
      );
      break;
    case 'union':
    case 'intersection':
      properties.push(
        factory.createPropertyAssignment(
          'schemas',
          factory.createArrayLiteralExpression(
            schema.schemas.map((item) => createSchemaExpression(typescript, factory, item)),
          ),
        ),
      );
      break;
    case 'array':
      properties.push(
        factory.createPropertyAssignment('items', createSchemaExpression(typescript, factory, schema.items)),
      );
      break;
    case 'tuple':
      properties.push(
        factory.createPropertyAssignment(
          'items',
          factory.createArrayLiteralExpression(
            schema.items.map((item) => createSchemaExpression(typescript, factory, item)),
          ),
        ),
      );
      if (schema.rest !== undefined) {
        properties.push(
          factory.createPropertyAssignment(
            'rest',
            schema.rest === false
              ? factory.createFalse()
              : createSchemaExpression(typescript, factory, schema.rest),
          ),
        );
      }
      break;
    case 'map':
      properties.push(
        factory.createPropertyAssignment('key', createSchemaExpression(typescript, factory, schema.key)),
        factory.createPropertyAssignment('value', createSchemaExpression(typescript, factory, schema.value)),
      );
      break;
    case 'set':
      properties.push(factory.createPropertyAssignment('item', createSchemaExpression(typescript, factory, schema.item)));
      break;
    case 'object': {
      const schemaProperties: ts.ObjectLiteralElementLike[] = [];
      for (const key of Reflect.ownKeys(schema.properties)) {
        const property = schema.properties[key];
        const propertyMembers: ts.ObjectLiteralElementLike[] = [
          factory.createPropertyAssignment(
            'schema',
            createSchemaExpression(typescript, factory, property.schema),
          ),
        ];
        if (property.optional !== undefined) {
          propertyMembers.push(
            factory.createPropertyAssignment(
              'optional',
              property.optional ? factory.createTrue() : factory.createFalse(),
            ),
          );
        }
        if (property.deferredAssignment !== undefined) {
          propertyMembers.push(
            factory.createPropertyAssignment(
              'deferredAssignment',
              property.deferredAssignment ? factory.createTrue() : factory.createFalse(),
            ),
          );
        }
        if (property.readonly === true) {
          propertyMembers.push(factory.createPropertyAssignment('readonly', factory.createTrue()));
        }
        schemaProperties.push(
          factory.createPropertyAssignment(
            createSchemaPropertyName(typescript, factory, key),
            factory.createObjectLiteralExpression(propertyMembers),
          ),
        );
      }
      properties.push(
        factory.createPropertyAssignment(
          'properties',
          factory.createObjectLiteralExpression(schemaProperties),
        ),
      );
      if (schema.allowExtraProperties !== undefined) {
        properties.push(
          factory.createPropertyAssignment(
            'allowExtraProperties',
            schema.allowExtraProperties ? factory.createTrue() : factory.createFalse(),
          ),
        );
      }
      if (schema.index !== undefined) {
        properties.push(
          factory.createPropertyAssignment(
            'index',
            createSchemaExpression(typescript, factory, schema.index),
          ),
        );
      }
      break;
    }
    case 'ref':
      properties.push(factory.createPropertyAssignment('name', factory.createStringLiteral(schema.name)));
      break;
    case 'templateLiteral':
      properties.push(factory.createPropertyAssignment('pattern', factory.createStringLiteral(schema.pattern)));
      break;
    case 'numericConstraint':
      properties.push(
        factory.createPropertyAssignment(
          'integer',
          schema.integer ? factory.createTrue() : factory.createFalse(),
        ),
      );
      if (schema.min !== undefined) {
        properties.push(
          factory.createPropertyAssignment('min', createLiteralExpression(typescript, factory, schema.min)),
        );
      }
      if (schema.max !== undefined) {
        properties.push(
          factory.createPropertyAssignment('max', createLiteralExpression(typescript, factory, schema.max)),
        );
      }
      break;
    case 'stringLength':
      if (schema.minLength !== undefined) {
        properties.push(
          factory.createPropertyAssignment(
            'minLength',
            createLiteralExpression(typescript, factory, schema.minLength),
          ),
        );
      }
      if (schema.maxLength !== undefined) {
        properties.push(
          factory.createPropertyAssignment(
            'maxLength',
            createLiteralExpression(typescript, factory, schema.maxLength),
          ),
        );
      }
      break;
    case 'unknown':
    case 'never':
    case 'date':
    case 'function':
      break;
    default:
      return assertUnreachable(schema);
  }

  return factory.createObjectLiteralExpression(properties);
}

function createLiteralExpression(
  typescript: typeof import('typescript'),
  factory: ts.NodeFactory,
  value: string | number | boolean | bigint | null | undefined,
): ts.Expression {
  if (value === undefined) {
    return factory.createVoidZero();
  }
  if (value === null) {
    return factory.createNull();
  }
  if (typeof value === 'string') {
    return factory.createStringLiteral(value);
  }
  if (typeof value === 'boolean') {
    return value ? factory.createTrue() : factory.createFalse();
  }
  if (typeof value === 'bigint') {
    return factory.createBigIntLiteral(`${value.toString()}n`);
  }
  if (Number.isNaN(value)) {
    return factory.createIdentifier('NaN');
  }
  if (value === Number.POSITIVE_INFINITY) {
    return factory.createIdentifier('Infinity');
  }
  if (value === Number.NEGATIVE_INFINITY) {
    return factory.createPrefixUnaryExpression(
      typescript.SyntaxKind.MinusToken,
      factory.createIdentifier('Infinity'),
    );
  }
  if (Object.is(value, -0) || value < 0) {
    return factory.createPrefixUnaryExpression(
      typescript.SyntaxKind.MinusToken,
      factory.createNumericLiteral(Math.abs(value)),
    );
  }
  return factory.createNumericLiteral(value);
}

function createSchemaPropertyName(
  typescript: typeof import('typescript'),
  factory: ts.NodeFactory,
  key: string | symbol,
): ts.PropertyName {
  if (typeof key === 'string') {
    if (key === '__proto__') {
      return factory.createComputedPropertyName(factory.createStringLiteral(key));
    }
    return factory.createStringLiteral(key);
  }

  const globalKey = Symbol.keyFor(key);
  if (globalKey !== undefined) {
    return factory.createComputedPropertyName(
      factory.createCallExpression(
        factory.createPropertyAccessExpression(factory.createIdentifier('Symbol'), 'for'),
        undefined,
        [factory.createStringLiteral(globalKey)],
      ),
    );
  }

  for (const wellKnownName of WELL_KNOWN_SYMBOL_NAMES) {
    if (Symbol[wellKnownName] === key) {
      return factory.createComputedPropertyName(
        factory.createPropertyAccessExpression(factory.createIdentifier('Symbol'), wellKnownName),
      );
    }
  }

  return factory.createComputedPropertyName(
    factory.createCallExpression(factory.createIdentifier('Symbol'), undefined, [
      factory.createStringLiteral(key.description ?? ''),
    ]),
  );
}

const WELL_KNOWN_SYMBOL_NAMES = [
  'asyncIterator',
  'hasInstance',
  'isConcatSpreadable',
  'iterator',
  'match',
  'matchAll',
  'replace',
  'search',
  'species',
  'split',
  'toPrimitive',
  'toStringTag',
  'unscopables',
] as const;

function assertUnreachable(value: never): never {
  throw new Error(`Unsupported schema: ${String(value)}`);
}
