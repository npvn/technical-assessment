// The problem details body every error leaves the API with (RFC 9457), apart
// from `type`, which the exception filter fills in from the code.
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
