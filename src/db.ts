import { homedir } from "node:os"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { Lesson, PluginOptions } from "./types.js"
import { DEFAULT_DB_PATH } from "./types.js"

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

export interface Database {
  insertLesson(lesson: {
    score: number
    rule: string
    raw_feedback: string
    source_prompt: string
    source_response: string
    workspace: string
  }): number
  listLessons(workspace: string, limit: number): Lesson[]
  deleteLesson(id: number): boolean
  close(): void
}

export async function initDatabase(options?: PluginOptions): Promise<Database> {
  const sql = await loadSqlJs()
  const dbPath = resolvePath(options?.dbPath)

  mkdirSync(dirname(dbPath), { recursive: true })

  let db: InstanceType<typeof sql.Database>

  try {
    const buffer = readFileSync(dbPath)
    db = new sql.Database(buffer)
  } catch {
    db = new sql.Database()
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS lessons (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      score       INTEGER NOT NULL CHECK(score >= 1 AND score <= 5),
      rule        TEXT NOT NULL DEFAULT '',
      raw_feedback TEXT NOT NULL,
      source_prompt  TEXT DEFAULT '',
      source_response TEXT DEFAULT '',
      workspace   TEXT DEFAULT '',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  db.run(`CREATE INDEX IF NOT EXISTS idx_lessons_workspace ON lessons(workspace)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_lessons_created ON lessons(created_at)`)

  function saveToDisk() {
    const data = db.export()
    const buffer = Buffer.from(data)
    writeFileSync(dbPath, buffer)
  }

  return {
    insertLesson(lesson): number {
      db.run(
        `INSERT INTO lessons
         (score, rule, raw_feedback, source_prompt, source_response, workspace)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          lesson.score,
          lesson.rule,
          lesson.raw_feedback,
          lesson.source_prompt,
          lesson.source_response,
          lesson.workspace,
        ]
      )
      const result = db.exec("SELECT last_insert_rowid()")
      const id = result[0]?.values?.[0]?.[0] as number
      saveToDisk()
      return id
    },

    listLessons(workspace: string, limit: number): Lesson[] {
      const result = db.exec(
        `SELECT id, score, rule, raw_feedback, source_prompt, source_response, workspace, created_at, updated_at
         FROM lessons
         WHERE workspace = ?
         ORDER BY created_at DESC
         LIMIT ?`,
        [workspace, limit]
      )
      if (!result.length || !result[0].values.length) return []
      return result[0].values.map((row: any[]) => ({
        id: row[0] as number,
        score: row[1] as number,
        rule: row[2] as string,
        raw_feedback: row[3] as string,
        source_prompt: row[4] as string,
        source_response: row[5] as string,
        workspace: row[6] as string,
        created_at: row[7] as string,
        updated_at: row[8] as string,
      }))
    },

    deleteLesson(id: number): boolean {
      const before = db.exec(
        `SELECT COUNT(*) FROM lessons WHERE id = ?`,
        [id]
      )
      const count = before[0]?.values?.[0]?.[0] as number
      if (!count) return false
      db.run(`DELETE FROM lessons WHERE id = ?`, [id])
      saveToDisk()
      return true
    },

    close(): void {
      db.close()
    },
  }
}
