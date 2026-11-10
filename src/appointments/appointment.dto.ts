import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import type { AppointmentResponse } from './http-mapping.js';
import { IsInstant } from './is-instant.decorator.js';

// The same classes validate the request and describe it in the OpenAPI spec,
// so the two can't drift apart (ADR 003).

export class CreateAppointmentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  customerId: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  vehicleId: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  dealershipId: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
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
