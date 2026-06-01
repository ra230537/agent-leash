import { logError } from "./logger.js"

interface SessionClient {
  session: {
    create(): Promise<{ data?: { id: string } }>
    prompt(input: {
      path: { id: string }
      body: { system: string; parts: Array<{ type: "text"; text: string }> }
    }): Promise<{ data?: { parts?: Array<{ type: string; text?: string }> } }>
    delete(input: { path: { id: string } }): Promise<unknown>
  }
}

const SYSTEM_PROMPT =
  "You are a preference extractor. Given a user's raw feedback about an AI assistant's response, summarize it into a concise, actionable rule (max 15 words) that the assistant should follow. Focus on the core instruction, ignore emotions and filler. Output ONLY the rule, no quotes, no prefix."

export function createSummarizer(client: SessionClient) {
  return async function summarizeFeedback(raw_feedback: string): Promise<string | null> {
    try {
      const sessionRes = await client.session.create()
      const session = sessionRes.data
      if (!session) return null

      const sessionID = session.id

      const promptRes = await client.session.prompt({
        path: { id: sessionID },
        body: {
          system: SYSTEM_PROMPT,
          parts: [{ type: "text", text: `Raw feedback: "${raw_feedback}"` }],
        },
      })

      const message = promptRes.data
      if (!message) {
        try { await client.session.delete({ path: { id: sessionID } }) } catch {}
        return null
      }

      const summary = (message.parts ?? [])
        .filter((p) => p.type === "text" && "text" in p)
        .map((p) => (p as { text: string }).text)
        .join("")
        .trim()

      try { await client.session.delete({ path: { id: sessionID } }) } catch {}

      return summary || null
    } catch (err) {
      logError("Summarization failed", err)
      return null
    }
  }
}
