import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { createDatabase } from '../../src/db/database.js';
import { migrateToLatest } from '../../src/db/migrator.js';
import { databaseUrl } from './database-url.js';

// Starts one Postgres for the whole test run, unless TEST_DATABASE_URL points
// at one already (handy in CI with a service container, or a local install).
// Then it builds a migrated template database. Every test file clones that
// template into its own database (see test-database.ts), which takes a few
// milliseconds instead of running the migrations again for each file.
let container: StartedPostgreSqlContainer | undefined;

export const TEMPLATE_DATABASE = 'scheduler_template';

declare module 'vitest' {
  export interface ProvidedContext {
    adminDatabaseUrl: string;
    templateDatabaseName: string;
  }
}

export async function setup(project: TestProject): Promise<void> {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    url = container.getConnectionUri();
  }

  // Always rebuild the template, so a schema change between runs never
  // leaves an old template behind on a reused server. The integration and
  // e2e projects both run this setup, and with TEST_DATABASE_URL they share
  // one server, so each project gets its own template name. Otherwise one
  // project could drop the template while the other is cloning it.
  const templateName = `${TEMPLATE_DATABASE}_${project.name}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${templateName} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${templateName}`);
  } finally {
    await admin.end();
  }

  const template = createDatabase({
    url: databaseUrl(url, templateName),
    poolSize: 1,
    statementTimeoutMs: 0,
    lockTimeoutMs: 0,
  });
  try {
    await migrateToLatest(template);
  } finally {
    // CREATE DATABASE ... TEMPLATE refuses to copy a database that has open
    // connections, so this has to be closed before any test file starts.
    await template.destroy();
  }

  project.provide('adminDatabaseUrl', url);
  project.provide('templateDatabaseName', templateName);
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
