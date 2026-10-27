import type { SchemaRegistry } from './schema-registry.class';

export interface AssertionContext {
  readonly contractKind:
    | 'property'
    | 'variable'
    | 'parameter'
    | 'return'
    | 'expression'
    | 'yield'
    | 'construction';
  readonly propertyPath: string;
  readonly operation:
    | 'initialize'
    | 'set'
    | 'define'
    | 'delete'
    | 'mutate'
    | 'argument'
    | 'return'
    | 'resolve'
    | 'yield'
    | 'assert';
  readonly className?: string;
  readonly functionName?: string;
  readonly isServerPopulated?: boolean;
  readonly typeErrorResponseMessage?: string;
  readonly typeErrorResponseStatus?: number;
  readonly registry?: SchemaRegistry;
  readonly extraProperties?: 'error' | 'strip';
  readonly enforceMutationGuards?: boolean;
}
