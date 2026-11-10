import { ValidationPipe, type INestApplication, type ValidationError } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ProblemFilter } from './problem.filter.js';
import { validationProblem } from './problem.js';

// Everything main.ts sets on the app that isn't a provider: the validation
// pipe, the problem+json filter and the OpenAPI docs. The e2e tests call the
// same function, so they test the app that ships.
export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({
      // An extra field is a 400 naming it (AC-20), not silently dropped
      whitelist: true,
      forbidNonWhitelisted: true,
      // One message per field is enough to fix it
      stopAtFirstError: true,
      exceptionFactory: (errors: ValidationError[]) => validationProblem(fieldErrors(errors)),
    }),
  );
  app.useGlobalFilters(new ProblemFilter());

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Unified Service Scheduler')
      .setDescription(
        'Books a service bay and a qualified technician for the whole length of a service appointment. Errors are application/problem+json with a stable code.',
      )
      .setVersion('0.1.0')
      .build(),
  );
  // UI at /docs, the JSON at /docs-json
  SwaggerModule.setup('docs', app, document);
}

// class-validator nests errors for nested objects. The body here is flat, but
// this keeps a dotted path if that ever changes.
function fieldErrors(errors: ValidationError[], parent = ''): { field: string; message: string }[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own = Object.values(error.constraints ?? {}).map((message) => ({ field, message }));
    return [...own, ...fieldErrors(error.children ?? [], field)];
  });
}
