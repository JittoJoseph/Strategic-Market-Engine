import pino from "pino";
import { getConfig } from "./config.js";

let loggerInstance: pino.Logger | null = null;

export function getLogger(): pino.Logger {
  if (!loggerInstance) {
    const config = getConfig();

    loggerInstance = pino({
      level: config.logging.level,
      transport:
        config.env === "development"
          ? {
              target: "pino-pretty",
              options: {
                colorize: true,
                translateTime: "SYS:standard",
                ignore: "pid,hostname",
              },
            }
          : {
              target: "pino-pretty",
              options: {
                colorize: false,
                translateTime: "SYS:HH:MM:ss",
                ignore: "pid,hostname,time",
                singleLine: true,
              },
            },
      formatters: {
        level: (label) => ({ level: label }),
      },
    });
  }

  return loggerInstance;
}

export function createModuleLogger(moduleName: string): pino.Logger {
  return getLogger().child({ module: moduleName });
}
