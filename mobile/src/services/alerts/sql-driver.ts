/**
 * Minimal SQL driver abstraction.
 *
 * Production uses `expo-sqlite` (see expo-sqlite-driver.ts); automated tests
 * use a real SQLite build compiled to WebAssembly (see the test driver).
 * Only the small subset the repository actually needs is abstracted.
 */

export type SqlValue = string | number | null;

export type SqlRunResult = Readonly<{ changes: number }>;

export interface SqlDriver {
  runAsync(sql: string, params?: readonly SqlValue[]): Promise<SqlRunResult>;
  getAllAsync<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, params?: readonly SqlValue[]): Promise<T | null>;
  execAsync(sql: string): Promise<void>;
  /** Runs the task inside a transaction; concurrent tasks must not interleave. */
  withTransactionAsync<T>(task: () => Promise<T>): Promise<T>;
  closeAsync(): Promise<void>;
}
