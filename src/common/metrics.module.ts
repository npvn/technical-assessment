import {
  Controller,
  Get,
  Global,
  Injectable,
  Module,
  Res,
  type MiddlewareConsumer,
  type NestMiddleware,
  type NestModule,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import { performance } from 'node:perf_hooks';
import { Metrics } from './metrics.js';

// Counts every HTTP request when its response finishes. By then Express has
// matched the route, so the label is the route template. A request that
// matched no route still has the route this middleware is mounted on, so it
// shows up as route="{/*splat}" (see forRoutes below). All of them share that
// one label, so random paths can't grow the series. "unmatched" is only the
// fallback for a request with no route at all, which I haven't seen happen.
@Injectable()
class HttpMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: Metrics) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const started = performance.now();
    res.on('finish', () => {
      const routePath = (req.route as { path?: unknown } | undefined)?.path;
      const labels = {
        method: req.method,
        route: typeof routePath === 'string' ? `${req.baseUrl}${routePath}` : 'unmatched',
        status: String(res.statusCode),
      };
      this.metrics.httpRequests.inc(labels);
      this.metrics.httpDuration.observe(labels, (performance.now() - started) / 1000);
    });
    next();
  }
}

@ApiExcludeController()
@Controller('metrics')
class MetricsController {
  constructor(private readonly metrics: Metrics) {}

  @Get()
  async scrape(@Res() res: Response): Promise<void> {
    res.type(this.metrics.registry.contentType).send(await this.metrics.registry.metrics());
  }
}

@Global()
@Module({
  controllers: [MetricsController],
  providers: [Metrics, HttpMetricsMiddleware],
  exports: [Metrics],
})
export class MetricsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HttpMetricsMiddleware).forRoutes('{/*splat}');
  }
}
