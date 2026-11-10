import type { INestApplication } from '@nestjs/common';

// Everything main.ts sets on the app that isn't a provider: the validation
// pipe, the problem+json filter and the OpenAPI docs. The e2e tests call the
// same function, so they test the app that ships.
export function configureApp(_app: INestApplication): void {
  // not implemented
}
