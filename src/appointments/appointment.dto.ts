import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsUUID } from 'class-validator';
import type { AppointmentResponse } from './http-mapping.js';
import { IsInstant } from './is-instant.decorator.js';

// The same classes validate the request and describe it in the OpenAPI spec,
// so the two can't drift apart (ADR 003).

// A UUID is the same id in upper or lower case, and Postgres always hands it
// back in lower case. So every id is lower cased here, once, and the service,
// the request hash and the response only ever see that one form. Anything
// that isn't a string is left alone for @IsUUID to refuse.
const LowerCase = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  );

export class CreateAppointmentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  @LowerCase()
  customerId: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  @LowerCase()
  vehicleId: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  @LowerCase()
  dealershipId: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  @LowerCase()
  serviceTypeId: string;

  @ApiProperty({
    description:
      'ISO 8601 date and time with an explicit offset (Z or +01:00). Must be on the 15 minute grid in the dealership time zone.',
    example: '2027-03-09T09:00:00Z',
  })
  @IsInstant()
  startTime: string;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'Honoured or refused, never swapped for someone else.',
  })
  @IsOptional()
  @IsUUID('all')
  @LowerCase()
  preferredTechnicianId?: string | null;
}

export class AppointmentResponseDto implements AppointmentResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: ['confirmed', 'cancelled'] })
  status: string;

  @ApiProperty({ format: 'uuid' })
  customerId: string;

  @ApiProperty({ format: 'uuid' })
  vehicleId: string;

  @ApiProperty({ format: 'uuid' })
  dealershipId: string;

  @ApiProperty({ format: 'uuid' })
  serviceTypeId: string;

  @ApiProperty({ format: 'uuid' })
  serviceBayId: string;

  @ApiProperty({ format: 'uuid' })
  technicianId: string;

  @ApiProperty({ example: '2027-03-09T09:00:00Z', description: 'UTC' })
  startsAt: string;

  @ApiProperty({ example: '2027-03-09T10:00:00Z', description: 'UTC' })
  endsAt: string;

  @ApiProperty({
    example: '2027-03-09T09:00:00+00:00',
    description: 'Dealership local time with a numeric offset',
  })
  startsAtLocal: string;

  @ApiProperty({
    example: '2027-03-09T10:00:00+00:00',
    description: 'Dealership local time with a numeric offset',
  })
  endsAtLocal: string;

  @ApiProperty({ example: 'Europe/London', description: 'The dealership IANA time zone' })
  timeZone: string;

  @ApiProperty({ example: '2027-03-01T09:00:00Z', description: 'UTC' })
  createdAt: string;
}
