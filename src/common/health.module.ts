import { Controller, Get, Inject, Module } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorService,
  TerminusModule,
} from '@nestjs/terminus';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { DATABASE } from './database.module.js';

// How long /health/ready waits for SELECT 1. pg has no connect timeout by
// default, so a database host that drops packets would otherwise hang the
// probe until the orchestrator gives up on it.
const READY_TIMEOUT_MS = 1_000;

@ApiTags('health')
@Controller('health')
class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicator: HealthIndicatorService,
    @Inject(DATABASE) private readonly db: Kysely<Database>,
  ) {}

  // The liveness probe. It never touches the database, so a database blip
  // doesn't make the orchestrator restart every instance at once (AC-34).
  @Get('live')
  @HealthCheck()
  live() {
    return this.health.check([]);
  }

  // The readiness probe. 503 when the database doesn't answer, so the load
  // balancer stops sending traffic here (AC-34). The 503 is an HttpException,
  // so it leaves through the ProblemFilter as problem+json.
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([() => this.database()]);
  }

  private async database() {
    const session = this.indicator.check('database');
    try {
      await withTimeout(sql`SELECT 1`.execute(this.db), READY_TIMEOUT_MS);
      return session.up();
    } catch {
      return session.down();
    }
  }
}

export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
})
export class HealthModule {}
