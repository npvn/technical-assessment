import { Controller, Get, Query } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProblemDto, problemResponse } from '../common/problem.dto.js';
import {
  AvailabilityQueryDto,
  AvailabilityResponseDto,
  type AvailabilityResponse,
} from './availability.dto.js';
import { AvailabilityService } from './availability.service.js';

@ApiTags('availability')
@ApiExtraModels(ProblemDto)
@Controller('availability')
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get()
  @ApiOkResponse({
    type: AvailabilityResponseDto,
    description:
      'The free starts that day. An empty list for a closed day, a past day, a day past the 90 day window, or a dealership that cannot do this service.',
  })
  @ApiResponse(problemResponse(400, 'VALIDATION_FAILED'))
  @ApiResponse(problemResponse(404, 'DEALERSHIP_NOT_FOUND, SERVICE_TYPE_NOT_FOUND'))
  find(@Query() query: AvailabilityQueryDto): Promise<AvailabilityResponse> {
    return this.availability.find(query);
  }
}
