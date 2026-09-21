import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import dataSource from '@server/datasource';
import type { MigrationInterface } from 'typeorm';
import { DataSource } from 'typeorm';

// The last fork migration that adds a column to `media_request`. Everything at
// or below this timestamp is what a production database already carries before
// an upstream migration that rebuilds the table is applied.
const FORK_AUTO_DELETE_MIGRATION_TIMESTAMP = 1771100000001;

// TypeORM derives a migration's ordering key from the last 13 characters of its
// class name, so read the timestamp back the same way.
const timestampOf = (migration: MigrationInterface): number =>
  parseInt(
    (migration.name ?? migration.constructor.name).slice(-13),
    10
  );

/**
 * A throwaway in-memory database that runs the real sqlite migration chain —
 * `synchronize: false`, so the schema is whatever the migrations produce and
 * nothing is derived from the entities.
 */
const createMigrationDataSource = async (): Promise<DataSource> => {
  const ds = new DataSource({
    type: 'sqlite',
    database: ':memory:',
    synchronize: false,
    entities: [],
    migrations: dataSource.options.migrations,
  });
  await ds.initialize();
  return ds;
};

const setMigrations = (ds: DataSource, migrations: MigrationInterface[]) => {
  (ds as unknown as { migrations: MigrationInterface[] }).migrations =
    migrations;
};

describe('fork columns survive the upstream migration chain', () => {
  it('keeps autoDeleteDays, autoDeleteDate and ignoreQuota on media_request after the full chain', async () => {
    const ds = await createMigrationDataSource();

    try {
      await ds.runMigrations();

      const columns: { name: string }[] = await ds.query(
        `PRAGMA table_info(media_request)`
      );
      const columnNames = columns.map((column) => column.name);

      assert.ok(
        columnNames.includes('autoDeleteDays'),
        `media_request lost the fork column autoDeleteDays; columns: ${columnNames.join(', ')}`
      );
      assert.ok(
        columnNames.includes('autoDeleteDate'),
        `media_request lost the fork column autoDeleteDate; columns: ${columnNames.join(', ')}`
      );
      assert.ok(
        columnNames.includes('ignoreQuota'),
        `media_request lost the upstream column ignoreQuota; columns: ${columnNames.join(', ')}`
      );
    } finally {
      await ds.destroy();
    }
  });

  it('preserves auto-delete values written before the upstream media_request rebuild', async () => {
    const ds = await createMigrationDataSource();

    try {
      const allMigrations = [...ds.migrations];
      const throughForkColumns = allMigrations.filter(
        (migration) =>
          timestampOf(migration) <= FORK_AUTO_DELETE_MIGRATION_TIMESTAMP
      );

      assert.ok(
        throughForkColumns.length > 0 &&
          throughForkColumns.length < allMigrations.length,
        'expected upstream migrations after the fork auto-delete migrations'
      );

      // Stand where production stands: the fork columns exist and hold data.
      setMigrations(ds, throughForkColumns);
      await ds.runMigrations();
      await ds.query(
        `INSERT INTO "media_request" ("status", "type", "autoDeleteDays", "autoDeleteDate") VALUES (1, 'movie', 7, '2026-01-01 00:00:00')`
      );

      // Then apply everything upstream added afterwards.
      setMigrations(ds, allMigrations);
      await ds.runMigrations();

      const rows: { autoDeleteDays: number | null; autoDeleteDate: unknown }[] =
        await ds.query(
          `SELECT "autoDeleteDays", "autoDeleteDate" FROM "media_request"`
        );

      assert.equal(rows.length, 1);
      assert.equal(rows[0].autoDeleteDays, 7);
      assert.ok(
        rows[0].autoDeleteDate,
        'autoDeleteDate was emptied by the migration chain'
      );
    } finally {
      await ds.destroy();
    }
  });
});
