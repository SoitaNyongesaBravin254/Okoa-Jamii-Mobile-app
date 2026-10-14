# Okoa Jamii — Offline Alert Persistence (Phase 2)

A local, offline-first repository for emergency alerts. It stores alerts on
the device until a future sync worker can deliver them to a backend.
**Storing an alert locally is not delivery**: a fresh alert is always
`pending` and only becomes `sent` when a real server receipt is provided.

## Files

| File | Role |
| --- | --- |
| `sqlite-alert-repository.ts` | Repository: migrations, CRUD, validated status transitions |
| `alert-model.ts` | Pure domain logic: ids, validation, transition rules |
| `alert-mapper.ts` | Strict SQLite-row → model mapping |
| `alert-errors.ts` | `AlertStorageError` / `AlertNotFoundError` / `AlertValidationError` |
| `sql-driver.ts` | Minimal async SQL driver interface |
| `expo-sqlite-driver.ts` | Production driver (expo-sqlite, SDK 57) |
| `index.ts` | `getAlertRepository()` lazy singleton |
| `__tests__/` | Node-based tests (real SQLite via WebAssembly) |

## Schema (version 1)

Table `alerts`: `id` (PK), `created_at_utc`, `category`, `status`,
`location_state`, `latitude`, `longitude`, `location_accuracy`,
`location_unavailable_reason`, `server_receipt`, `retry_count`,
`updated_at_utc`. Indexes on `(created_at_utc)` and `(status, created_at_utc)`.
Validation is duplicated in SQL triggers (status/location/receipt guards), so
even raw SQL cannot insert a `sent` alert without a receipt.

## Migrations

`PRAGMA user_version` tracks the schema version. Migrations run in order
inside a transaction, re-reading the version so concurrent `initialize()`
calls cannot double-apply. A database newer than the code aborts with
`AlertStorageError`.

## Status rules

```
pending ──► sent    (requires a non-empty server receipt; terminal)
pending ──► failed
failed  ──► pending (retry; increments retry_count)
failed  ──► sent    (requires a server receipt; terminal)
sent    ──► ∞       (terminal — never reverts locally)
```

## What SQLite protects (and what it does not)

**Protects:** atomic, crash-safe persistence in the app's private sandbox;
parameterized SQL (no injection); schema-level validation; failed writes
surface as errors, never silent success.

**Does NOT protect:** the database file is **not encrypted** (no
SQLCipher layer is enabled), so on a rooted/jailbroken device or via a
forensic filesystem extraction the alert contents — including coordinates —
are readable. Backups (e.g. Android auto-backup) may include the file unless
excluded. Coordinates are stored in plain SQLite columns by design of this
phase; an encryption layer is a possible later hardening step.

**Logging:** the alert layer performs no logging at all, so coordinates,
receipts and payloads cannot leak into console output (covered by a test).

## Testing

`npm test` compiles the alert layer plus tests with a dedicated tsconfig and
runs them with the built-in `node:test` runner. Repository tests execute
against **real SQLite** compiled to WebAssembly (`node-sqlite3-wasm`,
dev-only dependency), exercising the exact SQL shipped to the app.

Device-only verification still required: run the app on a device/emulator and
confirm `expo-sqlite` creates `okoa-jamii.db` with the same schema.
