import type { CachedExchange } from "./types.js"

export function createExchangeCache(): Map<string, CachedExchange> {
  return new Map<string, CachedExchange>()
}

export function getExchange(
  cache: Map<string, CachedExchange>,
  sessionID: string
): CachedExchange | undefined {
  return cache.get(sessionID)
}

export function ensureExchange(
  cache: Map<string, CachedExchange>,
  sessionID: string
): CachedExchange {
  let entry = cache.get(sessionID)
  if (!entry) {
    entry = { prompt: "", response: "", assistantMessageID: "" }
    cache.set(sessionID, entry)
  }
  return entry
}

export function updatePrompt(
  cache: Map<string, CachedExchange>,
  sessionID: string,
  prompt: string
): void {
  const entry = ensureExchange(cache, sessionID)
  entry.prompt = prompt
  entry.response = ""
}

export function appendResponse(
  cache: Map<string, CachedExchange>,
  sessionID: string,
  text: string,
  messageID: string
): void {
  const entry = ensureExchange(cache, sessionID)
  if (entry.assistantMessageID !== messageID) {
    entry.response = text
    entry.assistantMessageID = messageID
  } else {
    entry.response += text
  }
}
