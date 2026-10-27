const classMetadata = new WeakMap<object, 'error' | 'strip'>();
const propertyMetadata = new WeakMap<object, Map<string | symbol, 'error' | 'strip'>>();

export function ExtraProperties(policy: 'error' | 'strip'): ClassDecorator & PropertyDecorator {
  return (target: object, propertyKey?: string | symbol): void => {
    if (propertyKey === undefined) {
      classMetadata.set(target, policy);
      return;
    }

    const keys = propertyMetadata.get(target) ?? new Map<string | symbol, 'error' | 'strip'>();
    keys.set(propertyKey, policy);
    propertyMetadata.set(target, keys);
  };
}

export function getExtraPropertiesPolicy(
  target: object,
  propertyKey?: string | symbol,
): 'error' | 'strip' | undefined {
  if (propertyKey !== undefined) {
    return getPropertyMetadata(target, propertyKey);
  }

  return getClassMetadata(target);
}

function getPropertyMetadata(
  target: object,
  propertyKey: string | symbol,
): 'error' | 'strip' | undefined {
  let current: object | null = target;

  while (current !== null) {
    const policy = propertyMetadata.get(current)?.get(propertyKey);
    if (policy !== undefined) {
      return policy;
    }
    current = Object.getPrototypeOf(current);
  }

  return undefined;
}

function getClassMetadata(target: object): 'error' | 'strip' | undefined {
  let current: object | null = target;

  while (current !== null) {
    const policy = classMetadata.get(current) ?? classMetadata.get(current.constructor);
    if (policy !== undefined) {
      return policy;
    }
    current = Object.getPrototypeOf(current);
  }

  return undefined;
}
