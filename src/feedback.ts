import type { Database } from "./db.js"
import type { CachedExchange } from "./types.js"
import type { AppPart } from "./part-types.js"
import { FEEDBACK_REGEX, LIST_REGEX, DELETE_REGEX, LIST_LIMIT } from "./types.js"

export type CommandResult =
  | { type: "feedback"; id: number; score: number; text: string }
  | { type: "list"; feedbacks: { id: number; score: number; rule: string; created_at: string }[] }
  | { type: "delete"; id: number }
  | { type: "error"; message: string }
  | { type: "none" }

export function parseMessage(text: string): CommandResult {
  const trimmed = text.trim()

  const feedbackMatch = trimmed.match(FEEDBACK_REGEX)
  if (feedbackMatch) {
    const score = parseInt(feedbackMatch[1], 10)
    const feedbackText = feedbackMatch[2]

    if (score < 1 || score > 5) {
      return {
        type: "error",
        message: `❌ Score inválido: use 1-5. Ex: #3 "texto"`,
      }
    }

    if (!feedbackText) {
      return {
        type: "error",
        message: `❌ Texto do feedback vazio. Ex: #3 "texto"`,
      }
    }

    return {
      type: "feedback",
      id: 0,
      score,
      text: feedbackText,
    }
  }

  if (LIST_REGEX.test(trimmed)) {
    return { type: "list", feedbacks: [] }
  }

  const deleteMatch = trimmed.match(DELETE_REGEX)
  if (deleteMatch) {
    return { type: "delete", id: parseInt(deleteMatch[1], 10) }
  }

  return { type: "none" }
}

export function isCommand(text: string): boolean {
  return text.trimStart().startsWith("#")
}

export function buildFeedbackParts(
  sessionID: string,
  messageID: string,
  text: string
): AppPart[] {
  return [
    {
      type: "text",
      id: crypto.randomUUID(),
      sessionID,
      messageID: messageID || "",
      text,
    },
  ]
}

export function buildListParts(
  sessionID: string,
  messageID: string,
  workspace: string,
  feedbacks: { id: number; score: number; rule: string; created_at: string }[]
): AppPart[] {
  if (feedbacks.length === 0) {
    return buildFeedbackParts(sessionID, messageID, "📭 Nenhum feedback registrado ainda.")
  }

  const lines = feedbacks.map((f) => {
    const trimmedRule = f.rule.length > 50 ? f.rule.substring(0, 50) + "..." : f.rule
    const date = formatDate(f.created_at)
    return `  #${f.id} | ⭐${f.score} | ${date} | ${trimmedRule}`
  })

  const shortWorkspace = workspace.split(/[/\\]/).pop() || workspace
  const header = `📋 Feedbacks (workspace: ${shortWorkspace}):\n${lines.join("\n")}`
  return buildFeedbackParts(sessionID, messageID, header)
}

export function buildDeleteParts(
  sessionID: string,
  messageID: string,
  id: number
): AppPart[] {
  return buildFeedbackParts(sessionID, messageID, `🗑️ Feedback #${id} deletado.`)
}

export function buildErrorParts(
  sessionID: string,
  messageID: string,
  message: string
): AppPart[] {
  return buildFeedbackParts(sessionID, messageID, message)
}

export function processCommand(
  text: string,
  sessionID: string,
  messageID: string,
  workspace: string,
  db: Database,
  cacheEntry: CachedExchange | undefined
): { parts: AppPart[]; success: boolean } {
  const result = parseMessage(text)

  switch (result.type) {
    case "feedback": {
      const id = db.insertLesson({
        score: result.score,
        rule: result.text,
        raw_feedback: result.text,
        source_prompt: cacheEntry?.prompt || "",
        source_response: cacheEntry?.response || "",
        workspace,
      })
      return {
        parts: buildFeedbackParts(
          sessionID,
          messageID,
          `✅ Feedback #${id} registrado (⭐${result.score})`
        ),
        success: true,
      }
    }

    case "list": {
      const feedbacks = db.listLessons(workspace, LIST_LIMIT)
      return {
        parts: buildListParts(sessionID, messageID, workspace, feedbacks),
        success: true,
      }
    }

    case "delete": {
      const deleted = db.deleteLesson(result.id)
      if (!deleted) {
        return {
          parts: buildErrorParts(
            sessionID,
            messageID,
            `❌ Feedback #${result.id} não encontrado.`
          ),
          success: false,
        }
      }
      return {
        parts: buildDeleteParts(sessionID, messageID, result.id),
        success: true,
      }
    }

    case "error": {
      return {
        parts: buildErrorParts(sessionID, messageID, result.message),
        success: false,
      }
    }

    case "none": {
      return { parts: [], success: false }
    }
  }
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr + "Z")
    const day = String(d.getDate()).padStart(2, "0")
    const month = String(d.getMonth() + 1).padStart(2, "0")
    const hours = String(d.getHours()).padStart(2, "0")
    const minutes = String(d.getMinutes()).padStart(2, "0")
    return `${day}/${month} ${hours}:${minutes}`
  } catch {
    return dateStr
  }
}
