import { homedir } from "node:os"
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Feedback, PluginOptions } from "./types.js"
import { DEFAULT_DB_PATH, PREFERENCES_PATH } from "./types.js"
import { logInfo } from "./logger.js"

type SqlJs = Awaited<ReturnType<typeof import("sql.js").default>>

let SQL: SqlJs | undefined

async function loadSqlJs(): Promise<SqlJs> {
  if (!SQL) {
    if (typeof process !== "undefined" && process.versions && !process.versions.node) {
      ;(process.versions as Record<string, string>).node = "0.0.0"
    }
    const initSqlJs = (await import("sql.js")).default
    SQL = await initSqlJs()
  }
  return SQL
}

function resolvePath(dbPath?: string): string {
  const raw = dbPath || DEFAULT_DB_PATH
  if (raw.startsWith("~")) {
    return raw.replace(/^~/, homedir())
  }
  return raw
}

function resolvePreferencesPath(): string {
  const raw = PREFERENCES_PATH
  if (raw.startsWith("~")) {
    return raw.replace(/^~/, homedir())
  }
  return raw
}

export interface Database {
  insertFeedback(feedback: {
    raw_feedback: string
    rule: string | null
    workspace: string
  }): number
  listFeedbacks(limit: number): Feedback[]
  deleteFeedback(id: number): boolean
  updateRule(id: number, rule: string): void
  rebuildPreferencesFile(): void
  close(): void
}

export async function initDatabase(options?: PluginOptions): Promise<Database> {
  const sql = await loadSqlJs()
  const dbPath = resolvePath(options?.dbPath)

  logInfo(`Inicializando banco de dados em: ${dbPath}`)
  mkdirSync(dirname(dbPath), { recursive: true })

  let db: InstanceType<typeof sql.Database>
  let isNew = false

  try {
    const buffer = readFileSync(dbPath)
    db = new sql.Database(buffer)
    logInfo(`Banco existente carregado (${buffer.length} bytes)`)
  } catch {
    db = new sql.Database()
    isNew = true
    logInfo("Banco novo criado em memória")
  }

  const tableResult = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='feedbacks'")
  const feedbacksExists = tableResult.length > 0 && tableResult[0].values.length > 0

  if (!feedbacksExists) {
    const lessonsResult = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='lessons'")
    const lessonsExists = lessonsResult.length > 0 && lessonsResult[0].values.length > 0

    if (lessonsExists) {
      logInfo("Migrando de 'lessons' para 'feedbacks'...")
      db.run(`
        CREATE TABLE feedbacks (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          raw_feedback TEXT NOT NULL,
          rule         TEXT DEFAULT NULL,
          workspace    TEXT DEFAULT 'global',
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)

      const tableInfo = db.exec("PRAGMA table_info(lessons)")
      const columns = tableInfo[0]?.values?.map((row: any[]) => row[1] as string) ?? []

      const hasRuleSummary = columns.includes("rule_summary")
      const ruleCol = hasRuleSummary ? "rule_summary" : "rule"

      db.run(`
        INSERT INTO feedbacks (id, raw_feedback, rule, workspace, created_at, updated_at)
        SELECT id, raw_feedback, ${ruleCol}, COALESCE(NULLIF(workspace, ''), 'global'), created_at, updated_at
        FROM lessons
      `)

      db.run("DROP TABLE lessons")
      logInfo("Migração concluída — lessons → feedbacks")
    } else {
      db.run(`
        CREATE TABLE IF NOT EXISTS feedbacks (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          raw_feedback TEXT NOT NULL,
          rule         TEXT DEFAULT NULL,
          workspace    TEXT DEFAULT 'global',
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
      logInfo("Tabela 'feedbacks' criada")
    }
  }

  db.run(`CREATE INDEX IF NOT EXISTS idx_feedbacks_workspace ON feedbacks(workspace)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_feedbacks_created ON feedbacks(created_at)`)

  logInfo(`Schema OK${isNew ? " (novo banco)" : ""}`)

  function saveToDisk() {
    const data = db.export()
    const buffer = Buffer.from(data)
    writeFileSync(dbPath, buffer)
  }

  function rebuildPreferencesFile(): void {
    const result = db.exec(
      `SELECT rule FROM feedbacks WHERE rule IS NOT NULL AND rule != '' ORDER BY created_at DESC`
    )
    const ruleRows = result[0]?.values ?? []
    const prefPath = resolvePreferencesPath()

    mkdirSync(dirname(prefPath), { recursive: true })

    if (ruleRows.length === 0) {
      writeFileSync(prefPath, "", "utf-8")
      logInfo("preferences.md regenerado (vazio — sem regras)")
      return
    }

    const lines = ruleRows.map((row: any[]) => `- ${row[0]}`)
    const content = `## Agent Preferences\n\n${lines.join("\n")}\n`
    writeFileSync(prefPath, content, "utf-8")
    logInfo(`preferences.md regenerado com ${ruleRows.length} regras`)
  }

  return {
    insertFeedback(feedback): number {
      db.run(
        `INSERT INTO feedbacks (raw_feedback, rule, workspace)
         VALUES (?, ?, ?)`,
        [feedback.raw_feedback, feedback.rule, feedback.workspace]
      )
      const result = db.exec("SELECT last_insert_rowid()")
      const id = result[0]?.values?.[0]?.[0] as number
      saveToDisk()
      logInfo(`DB: feedback #${id} inserido (workspace="${feedback.workspace}")`)
      return id
    },

    listFeedbacks(limit: number): Feedback[] {
      const result = db.exec(
        `SELECT id, raw_feedback, rule, workspace, created_at, updated_at
         FROM feedbacks
         ORDER BY created_at DESC
         LIMIT ?`,
        [limit]
      )
      if (!result.length || !result[0].values.length) {
        return []
      }
      const feedbacks = result[0].values.map((row: any[]) => ({
        id: row[0] as number,
        raw_feedback: row[1] as string,
        rule: (row[2] as string) ?? null,
        workspace: row[3] as string,
        created_at: row[4] as string,
        updated_at: row[5] as string,
      }))
      logInfo(`DB: listFeedbacks retornou ${feedbacks.length} feedbacks`)
      return feedbacks
    },

    deleteFeedback(id: number): boolean {
      const before = db.exec(
        `SELECT COUNT(*) FROM feedbacks WHERE id = ?`,
        [id]
      )
      const count = before[0]?.values?.[0]?.[0] as number
      if (!count) {
        logInfo(`DB: deleteFeedback #${id} — não encontrado`)
        return false
      }
      db.run(`DELETE FROM feedbacks WHERE id = ?`, [id])
      saveToDisk()
      logInfo(`DB: feedback #${id} deletado`)
      return true
    },

    updateRule(id: number, rule: string): void {
      db.run("UPDATE feedbacks SET rule = ?, updated_at = datetime('now') WHERE id = ?", [rule, id])
      saveToDisk()
      logInfo(`DB: rule atualizado para feedback #${id}: "${rule}"`)
    },

    rebuildPreferencesFile,

    close(): void {
      logInfo("DB: conexão SQLite fechada")
      db.close()
    },
  }
}
