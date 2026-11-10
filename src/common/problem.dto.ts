import {
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
  type ApiResponseOptions,
} from '@nestjs/swagger';
import type { FieldError, Problem } from './problem.js';

// The problem+json body as the OpenAPI spec shows it. Every controller
// documents its errors with problemResponse, so they all point at this one
// schema.

export class FieldErrorDto implements FieldError {
  @ApiProperty({ example: 'startTime' })
  field: string;

  @ApiProperty()
  message: string;
}

export class ProblemDto implements Problem {
  @ApiProperty({ example: 'about:blank' })
  type: string;

  @ApiProperty({ example: 'Slot unavailable' })
  title: string;

  @ApiProperty({ example: 409 })
  status: number;

  @ApiProperty({ example: 'SLOT_UNAVAILABLE', description: 'Stable, switch on this' })
  code: string;

  @ApiProperty()
  detail: string;

  @ApiPropertyOptional({ type: [FieldErrorDto], description: 'Only on 400 VALIDATION_FAILED' })
  errors?: FieldErrorDto[];
}

// A documented problem+json response for the OpenAPI spec. The controller
// also needs @ApiExtraModels(ProblemDto) so the schema it points at exists.
export function problemResponse(status: number, description: string): ApiResponseOptions {
  return {
    status,
    description,
    content: { 'application/problem+json': { schema: { $ref: getSchemaPath(ProblemDto) } } },
  };
}
