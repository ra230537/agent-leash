import type { Plugin } from "@opencode-ai/plugin"
import { initDatabase } from "./db.js"
import { isCommand, processCommand } from "./feedback.js"
import { createSummarizer } from "./summarize.js"
import type { PluginOptions } from "./types.js"
import { PREFERENCES_PATH } from "./types.js"
import { logInfo, logWarn, logError } from "./logger.js"
import { readFileSync, existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname } from "node:path"

function resolvePreferencesPath(): string {
  const raw = PREFERENCES_PATH
  if (raw.startsWith("~")) {
    return raw.replace(/^~/, homedir())
  }
  return raw
}

const plugin: Plugin = async (input, options) => {
  const config = (options ?? {}) as PluginOptions
  logInfo(`Plugin inicializando v0.3 (dbPath=${config.dbPath ?? "default"})`)

  const db = await initDatabase(config)
  const summarizeFeedback = createSummarizer(input.client as any)

  db.rebuildPreferencesFile()
  logInfo("Banco de dados inicializado, preferências reconstruídas")

  function getTextFromParts(parts: readonly { type: string; text?: string }[]): string {
    return parts
      .filter((p) => p.type === "text" && p.text !== undefined)
      .map((p) => p.text!)
      .join("")
  }

  return {
    "chat.message": async (hookInput, output) => {
      const sessionID = hookInput.sessionID
      const messageID = hookInput.messageID || (output.message as any)?.id || ""
      const text = getTextFromParts(output.parts)

      if (!isCommand(text)) return

      const trimmed = text.trim()
      const shortText = trimmed.slice(0, 80).replace(/\n/g, "\\n")
      logInfo(`Comando detectado: "${shortText}"`)

      const result = processCommand(trimmed, sessionID, messageID, db)

      if (result.parts.length > 0) {
        output.parts.splice(0, output.parts.length)
        for (const part of result.parts) {
          output.parts.push(part as any)
        }
        logInfo(`Parts substituídas: "${result.parts[0]?.text?.slice(0, 60)}..."`)
      }

      if (result.feedbackId !== undefined) {
        const match = trimmed.match(/^#\s*(.+)$/)
        const rawText = match ? match[1].trim() : ""
        if (rawText) {
          logInfo(`Agendando resumo para feedback #${result.feedbackId}`)
          summarizeFeedback(rawText).then((rule) => {
            if (rule) {
              db.updateRule(result.feedbackId!, rule)
              db.rebuildPreferencesFile()
              logInfo(`Resumo salvo para feedback #${result.feedbackId}: "${rule}"`)
            } else {
              logWarn(`Resumo retornou vazio para feedback #${result.feedbackId}`)
            }
          }).catch((err) => {
            logError(`Falha ao resumir feedback #${result.feedbackId}`, err)
          })
        }
      }
    },

    "experimental.chat.system.transform": async (hookInput, output) => {
      try {
        const prefPath = resolvePreferencesPath()
        if (!existsSync(prefPath)) return

        const content = readFileSync(prefPath, "utf-8")
        if (!content || content.trim() === "") return

        output.system.push(content)
        logInfo(`preferences.md (${content.length} bytes) anexado ao system prompt`)
      } catch (err) {
        logError("Falha ao ler preferences.md", err)
      }
    },

    dispose: async () => {
      logInfo("Plugin sendo finalizado")
      db.close()
      logInfo("Plugin finalizado")
    },
  }
}

export { plugin as server }
export default plugin
export type { PluginOptions }
