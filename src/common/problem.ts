// The problem details body every error leaves the API with (RFC 9457), apart
// from `type`, which the exception filter fills in.
export interface FieldError {
  field: string;
  message: string;
}

export interface Problem {
  status: number;
  code: string;
  title: string;
  detail: string;
  // Only on 400 VALIDATION_FAILED
  errors?: FieldError[];
}

// Thrown anywhere in a request to answer with this problem. The filter turns
// it into the response, with any extra headers (Retry-After on a 503).
export class ProblemException extends Error {
  constructor(
    readonly problem: Problem,
    readonly headers: Record<string, string> = {},
  ) {
    super(problem.detail);
  }
}

export function validationProblem(errors: FieldError[]): ProblemException {
  return new ProblemException({
    status: 400,
    code: 'VALIDATION_FAILED',
    title: 'Validation failed',
    detail: 'The request is not valid. The errors list says what is wrong with each field.',
    errors,
  });
}
