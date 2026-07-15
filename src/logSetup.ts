/** Tee stdout/stderr to a log file so all prints are recorded. */

import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { WriteStream } from "node:fs";

import { formatUtcIsoZ } from "./timeUtils.js";

function resolveLogPath(logFile: string, useTimestamp: boolean): string {
  const raw = logFile.trim();
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const expanded = raw.replace(/^~(?=$|[\\/])/, home);
  const p = resolve(expanded);
  const ts = formatUtcIsoZ(new Date()).replace(/[-:]/g, "").slice(0, 15).replace("T", "_");
  if (useTimestamp) {
    if (p.toLowerCase().endsWith(".log")) {
      return resolve(dirname(p), `polybot5m_${ts}.log`);
    }
    return resolve(p, `polybot5m_${ts}.log`);
  }
  if (raw.endsWith("/") || raw.endsWith("\\")) {
    return resolve(raw.replace(/[/\\]+$/, ""), `polybot5m_${ts}.log`);
  }
  return p;
}

function teeStream(
  primary: NodeJS.WriteStream,
  secondary: WriteStream,
): () => void {
  const origWrite = primary.write.bind(primary);
  primary.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
    try {
      secondary.write(chunk as string, encoding as BufferEncoding);
    } catch {
      // ignore log write failures
    }
    return origWrite(chunk as string, encoding as BufferEncoding, cb as (() => void) | undefined);
  }) as typeof primary.write;
  return () => {
    primary.write = origWrite;
  };
}

export function installRunLogging(
  logFile: string,
  options?: {
    logAppend?: boolean;
    logTimestampName?: boolean;
    runKind?: string;
  },
): () => void {
  if (!logFile.trim()) {
    return () => undefined;
  }

  const timestamped =
    Boolean(options?.logTimestampName) || logFile.trim().endsWith("/") || logFile.trim().endsWith("\\");
  const path = resolveLogPath(logFile, timestamped);
  mkdirSync(dirname(path), { recursive: true });
  const mode = options?.logAppend && !timestamped ? "a" : "w";
  const logFp = createWriteStream(path, { flags: mode, encoding: "utf8" });

  const restoreOut = teeStream(process.stdout, logFp);
  const restoreErr = teeStream(process.stderr, logFp);

  const runKind = options?.runKind ?? "run";
  const header =
    `\n${"=".repeat(60)}\n polybot5m ${runKind} started ${formatUtcIsoZ(new Date())}\n` +
    ` log: ${resolve(path)}\n${"=".repeat(60)}\n`;
  logFp.write(header);
  process.stdout.write(header);

  return () => {
    try {
      restoreOut();
      restoreErr();
      logFp.end();
    } catch {
      // ignore
    }
  };
}
