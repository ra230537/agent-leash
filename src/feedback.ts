import type { Database } from "./db.js"
import { LIST_LIMIT } from "./types.js"

export type CommandResult =
  | { type: "feedback"; id: number; text: string }
  | { type: "list"; feedbacks: { id: number; raw_feedback: string; rule: string | null; created_at: string }[] }
  | { type: "delete"; id: number }
  | { type: "error"; message: string }
  | { type: "none" }

export function parseMessage(text: string): CommandResult {
  const trimmed = text.trim()

  if (/^#list$/.test(trimmed)) {
    return { type: "list", feedbacks: [] }
  }

  const deleteMatch = trimmed.match(/^#delete\s+(\d+)$/)
  if (deleteMatch) {
    return { type: "delete", id: parseInt(deleteMatch[1], 10) }
  }

  const feedbackMatch = trimmed.match(/^#\s*(.+)$/)
  if (feedbackMatch) {
    const feedbackText = feedbackMatch[1].trim()
    if (!feedbackText) {
      return { type: "error", message: "❌ Feedback vazio. Ex: # texto" }
    }
    return { type: "feedback", id: 0, text: feedbackText }
  }

  if (trimmed.startsWith("#")) {
    return { type: "error", message: "❌ Feedback vazio. Ex: # texto" }
  }

  return { type: "none" }
}

export function isCommand(text: string): boolean {
  return text.trimStart().startsWith("#")
}

export function processCommand(
  text: string,
  sessionID: string,
  messageID: string,
  db: Database
): { parts: Array<{ type: "text"; id: string; sessionID: string; messageID: string; text: string }>; success: boolean; feedbackId?: number } {
  const result = parseMessage(text)

  switch (result.type) {
    case "feedback": {
      const id = db.insertFeedback({
        raw_feedback: result.text,
        rule: null,
        workspace: "global",
      })
      const part = buildPart(sessionID, messageID, `✅ Feedback #${id} registrado`)
      return { parts: [part], success: true, feedbackId: id }
    }

    case "list": {
      const feedbacks = db.listFeedbacks(LIST_LIMIT)
      if (feedbacks.length === 0) {
        const part = buildPart(sessionID, messageID, "📭 Nenhum feedback registrado ainda.")
        return { parts: [part], success: true }
      }
      const lines = feedbacks.map((f) => {
        const label = f.rule ?? (f.raw_feedback.length > 50 ? f.raw_feedback.substring(0, 50) + "..." : f.raw_feedback)
        return `  #${f.id} | ${label}`
      })
      const part = buildPart(sessionID, messageID, `📋 Feedbacks:\n${lines.join("\n")}`)
      return { parts: [part], success: true }
    }

    case "delete": {
      const deleted = db.deleteFeedback(result.id)
      if (!deleted) {
        const part = buildPart(sessionID, messageID, `❌ Feedback #${result.id} não encontrado.`)
        return { parts: [part], success: false }
      }
      const part = buildPart(sessionID, messageID, `🗑️ Feedback #${result.id} deletado.`)
      return { parts: [part], success: true }
    }

    case "error": {
      const part = buildPart(sessionID, messageID, result.message)
      return { parts: [part], success: false }
    }

    case "none": {
      return { parts: [], success: false }
    }
  }
}

function buildPart(
  sessionID: string,
  messageID: string,
  text: string
): { type: "text"; id: string; sessionID: string; messageID: string; text: string } {
  return {
    type: "text",
    id: crypto.randomUUID(),
    sessionID,
    messageID: messageID || "",
    text,
  }
}
