/**
 * Structured logger.
 *
 * Every message and every metadata value passes through `redactSensitive()`
 * before it reaches a sink, so a caller cannot leak a connection string or a
 * JWT by passing an object straight in.
 */

import { redactSensitive, sanitizeMessage } from '../config/redact';
import type { LogLevel } from '../config/env';

export type LogRecord = Readonly<{
  level: Exclude<LogLevel, 'debug'> | 'debug';
  time: string;
  message: string;
  meta?: Record<string, unknown>;
}>;

export type LogSink = (record: LogRecord) => void;

export type Logger = Readonly<{
  level: LogLevel;
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}>;

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function defaultSink(record: LogRecord): void {
  const line = JSON.stringify(record);
  if (record.level === 'error') {
    console.error(line);
  } else if (record.level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function createLogger(options: {
  level?: LogLevel;
  sink?: LogSink;
} = {}): Logger {
  const level: LogLevel = options.level ?? 'info';
  const sink: LogSink = options.sink ?? defaultSink;
  const threshold = LEVEL_ORDER[level];

  function write(entryLevel: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LEVEL_ORDER[entryLevel] < threshold) return;

    const record: LogRecord = {
      level: entryLevel,
      time: new Date().toISOString(),
      // Belt and braces: scrub the message even though callers should not
      // interpolate secrets into it in the first place.
      message: sanitizeMessage(message),
      ...(meta ? { meta: redactSensitive(meta) as Record<string, unknown> } : {}),
    };
    sink(record);
  }

  return Object.freeze({
    level,
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
  });
}

/** A logger that records nothing. Useful in unit tests. */
export function createSilentLogger(): Logger {
  return createLogger({ level: 'error', sink: () => undefined });
}
