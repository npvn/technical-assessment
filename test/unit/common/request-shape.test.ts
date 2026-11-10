import {
  RequestShapePipe,
  findProblem,
  MAX_DEPTH,
} from '../../../src/common/request-shape.pipe.js';
import { ProblemException } from '../../../src/common/problem.js';

// The guard in front of the ValidationPipe. The e2e tests send the bodies
// from the break-it run, this pins the edges.

// n arrays inside each other: [[[]]] is 3
function nested(n: number): unknown {
  let value: unknown = [];
  for (let i = 1; i < n; i++) value = [value];
  return value;
}

describe('findProblem', () => {
  it('a flat body like the booking one is fine', () => {
    expect(
      findProblem({ customerId: 'a', startTime: 'b', preferredTechnicianId: null }),
    ).toBeNull();
  });

  it(`a field nested ${MAX_DEPTH - 1} deep is fine, ${MAX_DEPTH} deep is refused`, () => {
    expect(findProblem({ foo: nested(MAX_DEPTH - 1) })).toBeNull();
    expect(findProblem({ foo: nested(MAX_DEPTH) })).toEqual({
      field: 'foo',
      message: `foo is nested deeper than ${MAX_DEPTH} levels`,
    });
  });

  it('a body that is itself nested too deep is refused as the body', () => {
    expect(findProblem(nested(MAX_DEPTH + 1))?.field).toBe('(body)');
  });

  it('100000 levels is refused without running out of stack', () => {
    expect(findProblem({ foo: nested(100_000) })?.field).toBe('foo');
  });

  it.each([
    'constructor',
    '__proto__',
    'prototype',
    'toString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
    '__defineGetter__',
    '__lookupSetter__',
  ])('an own key named %s is refused, naming it', (key) => {
    expect(findProblem(JSON.parse(`{"customerId":"a",${JSON.stringify(key)}:1}`))).toEqual({
      field: key,
      message: `property ${key} should not exist`,
    });
  });

  it('a reserved name further down is named with its path', () => {
    expect(findProblem(JSON.parse('{"foo":{"constructor":1}}'))?.field).toBe('foo.constructor');
  });

  it('names that only look a bit like them are left to the validation', () => {
    expect(findProblem({ Constructor: 1, proto: 1, toStrings: 1 })).toBeNull();
  });
});

describe('RequestShapePipe', () => {
  const pipe = new RequestShapePipe();

  it.each(['body', 'query'] as const)('refuses a bad %s with 400 VALIDATION_FAILED', (type) => {
    let thrown: unknown;
    try {
      pipe.transform(JSON.parse('{"constructor":1}'), { type });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProblemException);
    expect((thrown as ProblemException).problem).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      errors: [{ field: 'constructor', message: 'property constructor should not exist' }],
    });
  });

  it('hands a good value back unchanged', () => {
    const value = { customerId: 'a' };
    expect(pipe.transform(value, { type: 'body' })).toBe(value);
  });

  it('leaves path parameters alone', () => {
    expect(pipe.transform('constructor', { type: 'param' })).toBe('constructor');
  });
});
