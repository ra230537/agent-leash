import type { Database } from "./db.js"
import type { CachedExchange } from "./types.js"
import { AUTO_DETECT_REGEX, AUTO_DETECT_MIN_LENGTH } from "./types.js"

export function shouldAutoDetect(text: string, cachedResponse: string | undefined): boolean {
  if (!text || text.length < AUTO_DETECT_MIN_LENGTH) return false
  if (!cachedResponse || cachedResponse.trim() === "") return false
  return AUTO_DETECT_REGEX.test(text)
}

export function autoCapture(
  text: string,
  cachedEntry: CachedExchange | undefined,
  workspace: string,
  db: Database
): void {
  if (!cachedEntry) return

  db.insertLesson({
    score: 3,
    rule: text,
    raw_feedback: text,
    source_prompt: cachedEntry.prompt,
    source_response: cachedEntry.response,
    workspace,
  })
}
