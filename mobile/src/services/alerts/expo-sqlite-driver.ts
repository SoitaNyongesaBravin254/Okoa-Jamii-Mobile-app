/**
 * Production SQL driver backed by expo-sqlite (SDK 57 "next" async API).
 * This is the only file in the alert layer that imports expo-sqlite, so
 * Node-based tests can import the repository without pulling in native code.
 */

import * as SQLite from 'expo-sqlite';

import type { SqlDriver, SqlRunResult, SqlValue } from './sql-driver';

export const DEFAULT_DATABASE_NAME = 'okoa-jamii.db';

export async function openExpoSqliteDriver(
  databaseName: string = DEFAULT_DATABASE_NAME,
): Promise<SqlDriver> {
  const db = await SQLite.openDatabaseAsync(databaseName);

  return {
    async runAsync(sql: string, params: readonly SqlValue[] = []): Promise<SqlRunResult> {
      const result = await db.runAsync(sql, [...params]);
      return { changes: result.changes };
    },
    getAllAsync<T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
      return db.getAllAsync<T>(sql, [...params]);
    },
    getFirstAsync<T>(sql: string, params: readonly SqlValue[] = []): Promise<T | null> {
      return db.getFirstAsync<T>(sql, [...params]);
    },
    execAsync(sql: string): Promise<void> {
      return db.execAsync(sql);
    },
    // expo-sqlite's withTransactionAsync resolves void, so the task result is
    // captured through the closure.
    async withTransactionAsync<T>(task: () => Promise<T>): Promise<T> {
      let value!: T;
      await db.withTransactionAsync(async () => {
        value = await task();
      });
      return value;
    },
    closeAsync(): Promise<void> {
      return db.closeAsync();
    },
  };
}
