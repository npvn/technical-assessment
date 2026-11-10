import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../appointments/booking.tokens.js';
import { bookingProblem } from '../appointments/http-mapping.js';
import { ProblemException } from '../common/problem.js';
import { formatLocal, formatUtc } from '../common/time-format.js';
import { HORIZON_DAYS, STEP_MINUTES, type Clock } from '../scheduling/index.js';
import type { AvailabilityQueryDto, AvailabilityResponse } from './availability.dto.js';
import { AvailabilityReader } from './availability.reader.js';
import { computeSlots, localDayRange } from './compute-slots.js';

@Injectable()
export class AvailabilityService {
  constructor(
    private readonly reader: AvailabilityReader,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async find(query: AvailabilityQueryDto): Promise<AvailabilityResponse> {
    // Dealership first, then service type, the same order as booking
    const dealership = await this.reader.findDealership(query.dealershipId);
    if (!dealership) {
      throw new ProblemException(bookingProblem('DEALERSHIP_NOT_FOUND'));
    }
    const serviceType = await this.reader.findServiceType(query.serviceTypeId);
    if (!serviceType) {
      throw new ProblemException(bookingProblem('SERVICE_TYPE_NOT_FOUND'));
    }

    const day = localDayRange(query.date, dealership.timeZone);
    const loaded = await this.reader.loadDay(dealership.id, serviceType.skillCode, day);

    // A closed day, a past day or one past the window just comes back empty.
    // So does a dealership with no bay or no qualified technician, since this
    // is only a hint (the booking call answers SERVICE_NOT_OFFERED).
    const starts = computeSlots({
      date: query.date,
      timeZone: dealership.timeZone,
      openingHours: dealership.openingHours,
      durationMinutes: serviceType.durationMinutes,
      now: this.clock.now(),
      stepMinutes: STEP_MINUTES,
      horizonDays: HORIZON_DAYS,
      ...loaded,
    });

    return {
      dealershipId: dealership.id,
      serviceTypeId: serviceType.id,
      date: query.date,
      timeZone: dealership.timeZone,
      slots: starts.map((start) => ({
        startsAt: formatUtc(start),
        startsAtLocal: formatLocal(start, dealership.timeZone),
      })),
    };
  }
}
