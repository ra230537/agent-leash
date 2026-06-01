import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const LOG_DIR = join(homedir(), ".config", "opencode", "agent-leash")
const LOG_FILE = join(LOG_DIR, "agent-leash.log")

function timestamp(): string {
  return new Date().toISOString()
}

mkdirSync(LOG_DIR, { recursive: true })

export function logInfo(message: string): void {
  const line = `[${timestamp()}] INFO  ${message}`
  try { appendFileSync(LOG_FILE, line + "\n") } catch {}
}

export function logWarn(message: string): void {
  const line = `[${timestamp()}] WARN  ${message}`
  try { appendFileSync(LOG_FILE, line + "\n") } catch {}
}

export function logError(message: string, err?: unknown): void {
  const errStr = err instanceof Error ? err.message : String(err ?? "")
  const line = `[${timestamp()}] ERROR ${message}${errStr ? " — " + errStr : ""}`
  try { appendFileSync(LOG_FILE, line + "\n") } catch {}
}
