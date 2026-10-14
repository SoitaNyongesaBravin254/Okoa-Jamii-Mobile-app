/**
 * Test-only SQL driver backed by real SQLite compiled to WebAssembly
 * (`node-sqlite3-wasm`, dev dependency). It executes the same SQL the app
 * ships, so repository tests exercise genuine SQLite behaviour in Node.
 */

import { Database } from 'node-sqlite3-wasm';

import type { SqlDriver, SqlRunResult, SqlValue } from '../sql-driver';
import type { SQLiteValue } from './node-sqlite3-wasm-types';

export function openWasmSqliteDriver(filePath: string): SqlDriver {
  const db = new Database(filePath);

  return {
    async runAsync(sql: string, params: readonly SqlValue[] = []): Promise<SqlRunResult> {
      const result = db.run(sql, [...params] as SQLiteValue[]);
      return { changes: result.changes };
    },
    async getAllAsync<T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
      return db.all(sql, [...params] as SQLiteValue[]) as unknown as T[];
    },
    async getFirstAsync<T>(sql: string, params: readonly SqlValue[] = []): Promise<T | null> {
      return (db.get(sql, [...params] as SQLiteValue[]) ?? null) as T | null;
    },
    async execAsync(sql: string): Promise<void> {
      db.exec(sql);
    },
    async withTransactionAsync<T>(task: () => Promise<T>): Promise<T> {
      db.exec('BEGIN IMMEDIATE');
      try {
        const value = await task();
        db.exec('COMMIT');
        return value;
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // The transaction was already rolled back; surface the original error.
        }
        throw error;
      }
    },
    async closeAsync(): Promise<void> {
      db.close();
    },
  };
}
