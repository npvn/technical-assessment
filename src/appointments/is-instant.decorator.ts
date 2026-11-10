import { registerDecorator, type ValidationOptions } from 'class-validator';
import { parseInstant } from '../scheduling/index.js';

// The DTO side of parseInstant: a string that is a full ISO 8601 date and
// time with an offset (AC-17). Anything else, a number included, fails here.
export function IsInstant(options: ValidationOptions = {}): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isInstant',
      target: target.constructor,
      propertyName: String(propertyName),
      options: {
        message: `${String(propertyName)} must be an ISO 8601 date and time with an offset, for example 2027-03-09T09:00:00Z or 2027-03-09T10:00:00+01:00`,
        ...options,
      },
      validator: {
        validate: (value: unknown) => typeof value === 'string' && parseInstant(value) !== null,
      },
    });
  };
}
