import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

let container: StartedPostgreSqlContainer | undefined;

export async function setup(): Promise<void> {
  container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('commerce_test')
    .withUsername('commerce')
    .withPassword('commerce')
    .start();
  process.env.TEST_PG_URL = container.getConnectionUri();
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
