import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiResponse,
  ApiTags,
  getSchemaPath,
  type ApiResponseOptions,
} from '@nestjs/swagger';
import { isUUID } from 'class-validator';
import type { Response } from 'express';
import { ProblemException, validationProblem } from '../common/problem.js';
import { parseInstant } from '../scheduling/index.js';
import { AppointmentReader } from './appointment.reader.js';
import { AppointmentResponseDto, CreateAppointmentDto, ProblemDto } from './appointment.dto.js';
import { BookingService } from './booking.service.js';
import { toAppointmentResponse, toHttpAnswer, type AppointmentResponse } from './http-mapping.js';

// A documented problem+json response for the OpenAPI spec.
function problem(status: number, description: string): ApiResponseOptions {
  return {
    status,
    description,
    content: { 'application/problem+json': { schema: { $ref: getSchemaPath(ProblemDto) } } },
  };
}

@ApiTags('appointments')
@ApiExtraModels(ProblemDto)
@Controller('appointments')
export class AppointmentsController {
  constructor(
    private readonly booking: BookingService,
    private readonly reader: AppointmentReader,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiCreatedResponse({ type: AppointmentResponseDto, description: 'Booked' })
  @ApiResponse(problem(400, 'VALIDATION_FAILED'))
  @ApiResponse(
    problem(
      404,
      'DEALERSHIP_NOT_FOUND, SERVICE_TYPE_NOT_FOUND, CUSTOMER_NOT_FOUND, VEHICLE_NOT_FOUND, TECHNICIAN_NOT_FOUND',
    ),
  )
  @ApiResponse(
    problem(
      409,
      'Not at this time, try another: VEHICLE_ALREADY_BOOKED, TECHNICIAN_UNAVAILABLE, SLOT_UNAVAILABLE',
    ),
  )
  @ApiResponse(
    problem(
      422,
      'Can never work as asked: VEHICLE_NOT_OWNED_BY_CUSTOMER, TECHNICIAN_NOT_ELIGIBLE, SERVICE_NOT_OFFERED, START_NOT_ON_GRID, START_IN_PAST, BEYOND_BOOKING_HORIZON, OUTSIDE_OPENING_HOURS',
    ),
  )
  @ApiResponse(
    problem(
      503,
      'BOOKING_CONTENDED. The server could not decide in time, retry after Retry-After seconds',
    ),
  )
  async create(
    @Body() dto: CreateAppointmentDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AppointmentResponse> {
    // The DTO already checked it parses, so null here would be a bug
    const startTime = parseInstant(dto.startTime);
    if (!startTime) throw new Error('startTime passed validation but did not parse');

    const result = await this.booking.book({
      dealershipId: dto.dealershipId,
      serviceTypeId: dto.serviceTypeId,
      customerId: dto.customerId,
      vehicleId: dto.vehicleId,
      startTime,
      preferredTechnicianId: dto.preferredTechnicianId ?? null,
    });

    const answer = toHttpAnswer(result);
    if (answer.kind === 'problem') throw new ProblemException(answer.problem, answer.headers);
    if (result.kind !== 'created' && result.kind !== 'replayed') {
      throw new Error(`a ${result.kind} result mapped to a success`);
    }

    // Read back through the same reader GET uses, so both bodies match
    const view = await this.reader.findById(result.appointment.id);
    if (!view)
      throw new Error(`appointment ${result.appointment.id} not found right after booking`);

    res.status(answer.status).set(answer.headers);
    return toAppointmentResponse(view);
  }

  @Get(':id')
  @ApiOkResponse({ type: AppointmentResponseDto })
  @ApiResponse(problem(400, 'VALIDATION_FAILED, the id is not a UUID'))
  @ApiResponse(problem(404, 'APPOINTMENT_NOT_FOUND'))
  async findOne(@Param('id') id: string): Promise<AppointmentResponse> {
    if (!isUUID(id, 'all')) {
      throw validationProblem([{ field: 'id', message: 'id must be a UUID' }]);
    }
    const view = await this.reader.findById(id);
    if (!view) {
      throw new ProblemException({
        status: 404,
        code: 'APPOINTMENT_NOT_FOUND',
        title: 'Appointment not found',
        detail: 'There is no appointment with this id.',
      });
    }
    return toAppointmentResponse(view);
  }
}
