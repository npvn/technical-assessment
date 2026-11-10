import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import { IsLocalDate } from './is-local-date.decorator.js';

// The same classes validate the query and describe it in the OpenAPI spec,
// like the appointment DTOs (ADR 003).

export class AvailabilityQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  dealershipId: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  serviceTypeId: string;

  @ApiProperty({
    description: 'A local date in the dealership time zone, YYYY-MM-DD',
    example: '2027-03-09',
  })
  @IsLocalDate()
  date: string;
}

export interface SlotResponse {
  startsAt: string;
  startsAtLocal: string;
}

export interface AvailabilityResponse {
  dealershipId: string;
  serviceTypeId: string;
  date: string;
  timeZone: string;
  slots: SlotResponse[];
}

export class SlotResponseDto implements SlotResponse {
  @ApiProperty({ example: '2027-03-09T08:00:00Z', description: 'UTC' })
  startsAt: string;

  @ApiProperty({
    example: '2027-03-09T08:00:00+00:00',
    description: 'Dealership local time with a numeric offset',
  })
  startsAtLocal: string;
}

export class AvailabilityResponseDto implements AvailabilityResponse {
  @ApiProperty({ format: 'uuid' })
  dealershipId: string;

  @ApiProperty({ format: 'uuid' })
  serviceTypeId: string;

  @ApiProperty({ example: '2027-03-09' })
  date: string;

  @ApiProperty({ example: 'Europe/London', description: 'The dealership IANA time zone' })
  timeZone: string;

  @ApiProperty({
    type: [SlotResponseDto],
    description:
      'Starts where a bay and a qualified technician are free for the whole job. A hint only, it does not check the vehicle or a preferred technician, so booking one can still fail.',
  })
  slots: SlotResponseDto[];
}
