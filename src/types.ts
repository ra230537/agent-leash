export interface PluginOptions {
  dbPath?: string
  autoDetect?: boolean
}

export interface CachedExchange {
  prompt: string
  response: string
  assistantMessageID: string
}

export interface Lesson {
  id: number
  score: number
  rule: string
  raw_feedback: string
  source_prompt: string
  source_response: string
  workspace: string
  created_at: string
  updated_at: string
}

export interface FeedbackResult {
  id: number
  score: number
  text: string
}

export const FEEDBACK_REGEX = /^#\s*(\d+)\s*"([^"]*)"$/

export const DELETE_REGEX = /^#delete\s+(\d+)$/

export const LIST_REGEX = /^#list$/

export const AUTO_DETECT_PATTERNS = [
  "Na verdade",
  "Na real",
  "Corrigindo",
  "Melhor seria",
  "Mas na verdade",
]

export const AUTO_DETECT_REGEX = /^(Na verdade|Na real|Corrigindo|Melhor seria|Mas na verdade)[,:\s]/i

export const AUTO_DETECT_MIN_LENGTH = 20

export const DEFAULT_DB_PATH = "~/.config/opencode/agent-leash/agent-leash.db"

export const LIST_LIMIT = 20
