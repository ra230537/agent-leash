import type { Plugin } from "@opencode-ai/plugin"
import { initDatabase } from "./db.js"
import { createExchangeCache, updatePrompt, appendResponse, getExchange } from "./cache.js"
import { isCommand, processCommand } from "./feedback.js"
import { shouldAutoDetect, autoCapture } from "./detect.js"
import type { PluginOptions } from "./types.js"
import type { AppPart } from "./part-types.js"

const plugin: Plugin = async (input, options) => {
  const config = (options ?? {}) as PluginOptions
  const autoDetect = config.autoDetect !== undefined ? config.autoDetect : true
  const db = await initDatabase(config)
  const exchangeCache = createExchangeCache()

  function getTextFromParts(parts: readonly { type: string; text?: string }[]): string {
    return parts
      .filter((p) => p.type === "text" && p.text !== undefined)
      .map((p) => p.text!)
      .join("")
  }

  return {
    "experimental.text.complete": async (hookInput, output) => {
      appendResponse(
        exchangeCache,
        hookInput.sessionID,
        output.text,
        hookInput.messageID
      )
    },

    "chat.message": async (hookInput, output) => {
      const sessionID = hookInput.sessionID
      const messageID = hookInput.messageID || output.message.id
      const workspace = input.worktree
      const text = getTextFromParts(output.parts)

      if (isCommand(text)) {
        const cacheEntry = getExchange(exchangeCache, sessionID)
        const result = processCommand(
          text,
          sessionID,
          messageID,
          workspace,
          db,
          cacheEntry
        )

        if (result.parts.length > 0) {
          output.parts.splice(0, output.parts.length)
          for (const part of result.parts) {
            output.parts.push(part)
          }
        }
        return
      }

      if (autoDetect) {
        const cacheEntry = getExchange(exchangeCache, sessionID)
        if (cacheEntry && shouldAutoDetect(text, cacheEntry.response)) {
          autoCapture(text, cacheEntry, workspace, db)
        }
      }

      updatePrompt(exchangeCache, sessionID, text)
    },

    dispose: async () => {
      db.close()
      exchangeCache.clear()
    },
  }
}

export { plugin as server }
export default plugin
export type { PluginOptions }
