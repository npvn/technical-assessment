import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { validationProblem } from './problem.js';

// Runs before the ValidationPipe on the body and the query string, and
// refuses two shapes that the validation can't handle on its own. Both are a
// 400 VALIDATION_FAILED naming the field, like any other bad field (AC-20).
//
// - Nesting deeper than MAX_DEPTH. class-transformer walks a value with
//   recursion and runs out of stack somewhere between 1000 and 2000 levels,
//   which was a 500 for a 4 KB body. No field here is nested at all, so 32
//   leaves plenty of room and is far from that limit. The walk below uses its
//   own stack, so it can't overflow itself.
// - Own keys named like an Object.prototype member (constructor, __proto__,
//   toString and the rest) or prototype. Every object already "has" those
//   through its prototype, so the "no unknown fields" check let them through.

export const MAX_DEPTH = 32;

const RESERVED_KEYS = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);

@Injectable()
export class RequestShapePipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'body' && metadata.type !== 'query') return value;
    const problem = findProblem(value);
    if (problem) throw validationProblem([problem]);
    return value;
  }
}

// The first problem found, or null. The field is the top level key the
// problem sits under, since that's the field a client sent.
export function findProblem(value: unknown): { field: string; message: string } | null {
  const stack: { value: unknown; depth: number; field: string }[] = [
    { value, depth: 0, field: '' },
  ];
  while (stack.length > 0) {
    const { value: current, depth, field } = stack.pop()!;
    if (typeof current !== 'object' || current === null) continue;
    if (depth >= MAX_DEPTH) {
      return {
        field: field || '(body)',
        message: `${field || 'the body'} is nested deeper than ${MAX_DEPTH} levels`,
      };
    }
    for (const key of Object.keys(current)) {
      // A body that is an array has no field names, only indexes
      const own = field || (Array.isArray(current) ? '' : key);
      if (RESERVED_KEYS.has(key)) {
        return {
          field: field ? `${field}.${key}` : key,
          message: `property ${key} should not exist`,
        };
      }
      stack.push({
        value: (current as Record<string, unknown>)[key],
        depth: depth + 1,
        field: own,
      });
    }
  }
  return null;
}
