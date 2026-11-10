import { registerDecorator, type ValidationOptions } from 'class-validator';
import { DateTime } from 'luxon';

// A calendar date written exactly as YYYY-MM-DD that really exists, so
// 2027-3-9 and 2027-02-30 both fail. No time and no zone, the zone comes
// from the dealership.
export function isLocalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return DateTime.fromISO(value, { zone: 'utc' }).isValid;
}

export function IsLocalDate(options: ValidationOptions = {}): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isLocalDate',
      target: target.constructor,
      propertyName: String(propertyName),
      options: {
        message: `${String(propertyName)} must be a date written as YYYY-MM-DD, for example 2027-03-09`,
        ...options,
      },
      validator: { validate: isLocalDate },
    });
  };
}
