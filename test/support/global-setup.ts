import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

// Starts one Postgres for the whole test run, unless TEST_DATABASE_URL points
// at one already (handy in CI with a service container, or a local install).
let container: StartedPostgreSqlContainer | undefined;

declare module 'vitest' {
  export interface ProvidedContext {
    adminDatabaseUrl: string;
  }
}

export async function setup(project: TestProject): Promise<void> {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    url = container.getConnectionUri();
  }
  project.provide('adminDatabaseUrl', url);
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
