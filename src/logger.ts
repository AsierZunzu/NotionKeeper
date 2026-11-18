import { format as formatWithNode } from 'node:util';

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

function timestamp(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function stringify(arg: unknown): string {
  if (typeof arg === 'string') {
    return arg;
  }
  return formatWithNode('%o', arg);
}

/**
 * Formats an SLF4J-style message: each '{}' is replaced by the next argument.
 * A trailing Error argument that has no matching placeholder is printed as a stack trace.
 */
export function formatMessage(message: string, args: unknown[]): string {
  let argIndex = 0;
  let result = message.replace(/\{\}/g, (placeholder) => {
    if (argIndex >= args.length) {
      return placeholder;
    }
    return stringify(args[argIndex++]);
  });
  const remaining = args.slice(argIndex);
  const lastArg = remaining.at(-1);
  if (lastArg instanceof Error) {
    result += `\n${lastArg.stack ?? String(lastArg)}`;
  }
  return result;
}

export function createLogger(name: string): Logger {
  const write = (level: Level, message: string, args: unknown[]): void => {
    // Everything goes to stdout, like logback's default console appender
    process.stdout.write(`${timestamp(new Date())} [main] ${level.padEnd(5)} ${name} -- ${formatMessage(message, args)}\n`);
  };
  return {
    debug: (message, ...args) => write('DEBUG', message, args),
    info: (message, ...args) => write('INFO', message, args),
    warn: (message, ...args) => write('WARN', message, args),
    error: (message, ...args) => write('ERROR', message, args),
  };
}
