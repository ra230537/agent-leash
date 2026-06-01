export interface PluginOptions {
  dbPath?: string
}

export interface Feedback {
  id: number
  raw_feedback: string
  rule: string | null
  workspace: string
  created_at: string
  updated_at: string
}

export const FEEDBACK_REGEX = /^#\s*(.+)$/

export const LIST_REGEX = /^#list$/

export const DELETE_REGEX = /^#delete\s+(\d+)$/

export const DEFAULT_DB_PATH = "~/.config/opencode/agent-leash/agent-leash.db"

export const PREFERENCES_PATH = "~/.config/opencode/agent-leash/preferences.md"

export const LIST_LIMIT = 20
