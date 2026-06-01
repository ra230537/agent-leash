import { parseMessage, isCommand, processCommand } from "./src/feedback.js"
import { initDatabase } from "./src/db.js"
import { PREFERENCES_PATH } from "./src/types.js"
import { homedir } from "node:os"
import { readFileSync, unlinkSync, existsSync } from "node:fs"

let passed = 0
let failed = 0

function test(name: string, fn: () => void | Promise<void>) {
  try {
    const result = fn()
    if (result instanceof Promise) {
      return result.then(() => {
        passed++
        console.log(`  PASS: ${name}`)
      }).catch((err) => {
        failed++
        console.log(`  FAIL: ${name} — ${err.message}`)
      })
    } else {
      passed++
      console.log(`  PASS: ${name}`)
    }
  } catch (err: any) {
    failed++
    console.log(`  FAIL: ${name} — ${err.message}`)
  }
}

function assert(condition: boolean, msg?: string) {
  if (!condition) throw new Error(msg || "assertion failed")
}

function assertEq<T>(a: T, b: T, msg?: string) {
  if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}

// ============================================================
// 1. Regex Tests (v0.3 — no score, no quotes)
// ============================================================
console.log("\n--- Regex Tests (v0.3) ---")

test("FEEDBACK_REGEX: # texto", () => {
  const m = "# texto".match(/^#\s*(.+)$/)
  assert(m !== null)
  assertEq(m![1], "texto")
})

test("FEEDBACK_REGEX: # use Kotlin em vez de Python", () => {
  const m = "# use Kotlin em vez de Python".match(/^#\s*(.+)$/)
  assert(m !== null)
  assertEq(m![1], "use Kotlin em vez de Python")
})

test("FEEDBACK_REGEX: #   com espaços", () => {
  const m = "#   com espaços".match(/^#\s*(.+)$/)
  assert(m !== null)
  assertEq(m![1], "com espaços")
})

test("FEEDBACK_REGEX: normal text not matched", () => {
  assert("hello world".match(/^#\s*(.+)$/) === null)
})

test("FEEDBACK_REGEX: #list also matches generic regex (checked first)", () => {
  const m = "#list".match(/^#\s*(.+)$/)
  assert(m !== null)
  assertEq(m![1], "list")
})

test("DELETE_REGEX: #delete 42", () => {
  const m = "#delete 42".match(/^#delete\s+(\d+)$/)
  assert(m !== null)
  assertEq(m![1], "42")
})

test("DELETE_REGEX: #delete 1 single digit", () => {
  const m = "#delete 1".match(/^#delete\s+(\d+)$/)
  assert(m !== null)
  assertEq(m![1], "1")
})

test("DELETE_REGEX: #delete without number fails", () => {
  assert("#delete".match(/^#delete\s+(\d+)$/) === null)
})

test("LIST_REGEX: #list", () => {
  assert(/^#list$/.test("#list"))
})

test("LIST_REGEX: #list with trailing space fails", () => {
  assert(/^#list$/.test("#list ") === false)
})

// ============================================================
// 2. parseMessage Tests (v0.3)
// ============================================================
console.log("\n--- parseMessage Tests (v0.3) ---")

test("parseMessage: # texto -> feedback type", () => {
  const r = parseMessage("# ficou confuso, organiza em tópicos")
  assertEq(r.type, "feedback")
  if (r.type === "feedback") {
    assertEq(r.text, "ficou confuso, organiza em tópicos")
  }
})

test("parseMessage: #list -> list type", () => {
  const r = parseMessage("#list")
  assertEq(r.type, "list")
})

test("parseMessage: #delete 7 -> delete type", () => {
  const r = parseMessage("#delete 7")
  assertEq(r.type, "delete")
  if (r.type === "delete") assertEq(r.id, 7)
})

test("parseMessage: #delete 42 -> delete type", () => {
  const r = parseMessage("#delete 42")
  assertEq(r.type, "delete")
  if (r.type === "delete") assertEq(r.id, 42)
})

test("parseMessage: normal text -> none", () => {
  const r = parseMessage("hello world")
  assertEq(r.type, "none")
})

test("parseMessage: empty # -> error", () => {
  const r = parseMessage("#")
  assertEq(r.type, "error")
})

test("parseMessage: # with only spaces -> error", () => {
  const r = parseMessage("#   ")
  assertEq(r.type, "error")
})

test("parseMessage: # text with leading space", () => {
  const r = parseMessage("  # use Kotlin")
  assertEq(r.type, "feedback")
  if (r.type === "feedback") {
    assertEq(r.text, "use Kotlin")
  }
})

test("parseMessage: #delete without number falls through to feedback", () => {
  const r = parseMessage("#delete")
  assertEq(r.type, "feedback")
  if (r.type === "feedback") {
    assertEq(r.text, "delete")
  }
})

// ============================================================
// 3. isCommand Tests
// ============================================================
console.log("\n--- isCommand Tests ---")

test("isCommand: #list", () => assert(isCommand("#list")))
test("isCommand: # texto", () => assert(isCommand("# texto")))
test("isCommand: #delete 5", () => assert(isCommand("#delete 5")))
test("isCommand: normal text", () => assert(!isCommand("hello world")))
test("isCommand: empty", () => assert(!isCommand("")))
test("isCommand: # with spaces before", () => assert(isCommand("  #list")))

// ============================================================
// 4. processCommand Tests (v0.3 — mock DB, no cache)
// ============================================================
console.log("\n--- processCommand Tests (v0.3) ---")

function createMockDB(): import("./src/db.js").Database {
  let nextId = 1
  const feedbacks: any[] = []
  return {
    insertFeedback(fb) {
      const id = nextId++
      const now = new Date().toISOString()
      feedbacks.push({ id, ...fb, created_at: now, updated_at: now })
      return id
    },
    listFeedbacks(limit) {
      return feedbacks
        .sort((a, b) => b.id - a.id)
        .slice(0, limit)
    },
    deleteFeedback(id) {
      const idx = feedbacks.findIndex(f => f.id === id)
      if (idx === -1) return false
      feedbacks.splice(idx, 1)
      return true
    },
    updateRule(id, rule) {
      const fb = feedbacks.find(f => f.id === id)
      if (fb) {
        fb.rule = rule
        fb.updated_at = new Date().toISOString()
      }
    },
    rebuildPreferencesFile() {},
    close() {},
  }
}

test("processCommand: feedback creates entry", () => {
  const db = createMockDB()
  const result = processCommand(
    "# use Kotlin em vez de Python",
    "s1", "m1",
    db
  )
  assertEq(result.success, true)
  assert(result.feedbackId !== undefined)
  if (result.feedbackId !== undefined) assert(result.feedbackId > 0)
  assert(result.parts.length > 0)
  assert(result.parts[0].text.includes("Feedback"))
  assert(result.parts[0].text.includes("registrado"))
})

test("processCommand: #list empty", () => {
  const db = createMockDB()
  const result = processCommand(
    "#list",
    "s1", "m1",
    db
  )
  assertEq(result.success, true)
  assert(result.parts[0].text.includes("Nenhum"))
})

test("processCommand: #list with data", () => {
  const db = createMockDB()
  db.insertFeedback({ raw_feedback: "use Kotlin", rule: null, workspace: "global" })
  db.insertFeedback({ raw_feedback: "responda em português", rule: "Responder em português", workspace: "global" })
  const result = processCommand(
    "#list",
    "s1", "m1",
    db
  )
  assertEq(result.success, true)
  const text = result.parts[0].text
  assert(text.includes("use Kotlin") || text.includes("responda em português"))
})

test("processCommand: #list shows rules when available", () => {
  const db = createMockDB()
  db.insertFeedback({ raw_feedback: "be concise", rule: "Be concise", workspace: "global" })
  const result = processCommand(
    "#list",
    "s1", "m1",
    db
  )
  assertEq(result.success, true)
  assert(result.parts[0].text.includes("Be concise"))
})

test("processCommand: #delete existing", () => {
  const db = createMockDB()
  const id = db.insertFeedback({ raw_feedback: "teste", rule: null, workspace: "global" })
  const result = processCommand(
    `#delete ${id}`,
    "s1", "m1",
    db
  )
  assertEq(result.success, true)
  assert(result.parts[0].text.includes(`${id}`))
  assert(result.parts[0].text.includes("deletado"))
})

test("processCommand: #delete non-existing", () => {
  const db = createMockDB()
  const result = processCommand(
    "#delete 999",
    "s1", "m1",
    db
  )
  assertEq(result.success, false)
  assert(result.parts[0].text.includes("não encontrado"))
})

test("processCommand: empty feedback (error)", () => {
  const db = createMockDB()
  const result = processCommand(
    "#",
    "s1", "m1",
    db
  )
  assertEq(result.success, false)
  assert(result.parts[0].text.includes("vazio"))
})

test("processCommand: non-command returns empty parts", () => {
  const db = createMockDB()
  const result = processCommand(
    "hello world",
    "s1", "m1",
    db
  )
  assertEq(result.success, false)
  assertEq(result.parts.length, 0)
})

test("processCommand: parts have correct structure", () => {
  const db = createMockDB()
  const result = processCommand(
    "# test",
    "session-abc", "msg-xyz",
    db
  )
  const part = result.parts[0]
  assertEq(part.type, "text")
  assertEq(part.sessionID, "session-abc")
  assertEq(part.messageID, "msg-xyz")
  assert(typeof part.id === "string")
  assert(part.id.length > 0)
})

// ============================================================
// 5. Database Tests — new feedbacks schema (v0.3)
// ============================================================
console.log("\n--- Database Tests (v0.3) ---")

async function runDbTests() {
  const dbPath = "./test-agent-leash-v03.db"

  // Cleanup from previous run
  try { unlinkSync(dbPath) } catch {}

  const db = await initDatabase({ dbPath })

  test("db: insertFeedback returns an id", () => {
    const id = db.insertFeedback({
      raw_feedback: "better use async",
      rule: null,
      workspace: "global",
    })
    assert(typeof id === "number")
    assert(id > 0)
  })

  test("db: insertFeedback with rule", () => {
    const id = db.insertFeedback({
      raw_feedback: "organiza em tópicos",
      rule: "Organizar respostas em tópicos",
      workspace: "global",
    })
    assert(typeof id === "number")
    assert(id > 0)
  })

  test("db: listFeedbacks returns results", () => {
    const feedbacks = db.listFeedbacks(10)
    assert(feedbacks.length >= 2)
    assert(feedbacks[0].id > 0)
    assert(typeof feedbacks[0].raw_feedback === "string")
  })

  test("db: listFeedbacks ordered by created_at DESC", () => {
    db.insertFeedback({ raw_feedback: "newest", rule: null, workspace: "global" })
    const feedbacks = db.listFeedbacks(10)
    assert(feedbacks.length >= 3)
    // newest first
    assertEq(feedbacks[0].raw_feedback, "newest")
  })

  test("db: deleteFeedback works", () => {
    const id = db.insertFeedback({
      raw_feedback: "to delete",
      rule: null,
      workspace: "global",
    })
    const deleted = db.deleteFeedback(id)
    assertEq(deleted, true)
    const deleted2 = db.deleteFeedback(id)
    assertEq(deleted2, false)
  })

  test("db: updateRule sets rule", () => {
    const id = db.insertFeedback({
      raw_feedback: "rasc",
      rule: null,
      workspace: "global",
    })
    db.updateRule(id, "Prefira respostas curtas")
    const feedbacks = db.listFeedbacks(10)
    const updated = feedbacks.find(f => f.id === id)
    assert(updated !== undefined)
    assertEq(updated!.rule, "Prefira respostas curtas")
  })

  test("db: insertFeedback with empty fields", () => {
    const id = db.insertFeedback({
      raw_feedback: "",
      rule: null,
      workspace: "global",
    })
    assert(typeof id === "number")
    assert(id > 0)
  })

  test("db: rebuildPreferencesFile creates file", () => {
    db.insertFeedback({
      raw_feedback: "seja conciso",
      rule: "Seja conciso",
      workspace: "global",
    })
    db.rebuildPreferencesFile()

    const prefPath = resolvePreferencesPath()
    assert(existsSync(prefPath), "preferences.md should exist")
    const content = readFileSync(prefPath, "utf-8")
    assert(content.includes("## Agent Preferences"))
    assert(content.includes("Seja conciso"))
  })

  test("db: rebuildPreferencesFile empty when no rules", () => {
    const allFeedbacks = db.listFeedbacks(100)
    for (const fb of allFeedbacks) {
      if (fb.rule) db.deleteFeedback(fb.id)
    }
    db.rebuildPreferencesFile()
    const prefPath = resolvePreferencesPath()
    const content = readFileSync(prefPath, "utf-8")
    assertEq(content, "")
  })

  db.close()

  // Cleanup
  try { unlinkSync(dbPath) } catch {}
  try {
    const prefPath = resolvePreferencesPath()
    if (existsSync(prefPath)) unlinkSync(prefPath)
  } catch {}
}

function resolvePreferencesPath(): string {
  const raw = PREFERENCES_PATH
  if (raw.startsWith("~")) {
    return raw.replace(/^~/, homedir())
  }
  return raw
}

// ============================================================
// 6. Migration Tests (lessons -> feedbacks)
// ============================================================
console.log("\n--- Migration Tests (lessons -> feedbacks) ---")

async function runMigrationTests() {
  const dbPath = "./test-agent-leash-migration.db"

  // Cleanup
  try { unlinkSync(dbPath) } catch {}

  // Create a v0.2-style lessons table manually via sql.js
  const initSqlJs = (await import("sql.js")).default
  const sql = await initSqlJs()

  const { writeFileSync, readFileSync } = await import("node:fs")
  let rawDb = new sql.Database()

  rawDb.run(`
    CREATE TABLE lessons (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      score       INTEGER NOT NULL,
      rule        TEXT NOT NULL DEFAULT '',
      rule_summary TEXT DEFAULT NULL,
      raw_feedback TEXT NOT NULL,
      source_prompt  TEXT DEFAULT '',
      source_response TEXT DEFAULT '',
      embedding   BLOB DEFAULT NULL,
      workspace   TEXT DEFAULT '',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  rawDb.run(`
    INSERT INTO lessons (score, rule, rule_summary, raw_feedback, source_prompt, source_response, workspace)
    VALUES (4, 'use async', 'Preferir async/await', 'better use async', 'how to promise', 'use .then()', '/test')
  `)
  rawDb.run(`
    INSERT INTO lessons (score, rule, rule_summary, raw_feedback, source_prompt, source_response, workspace)
    VALUES (5, 'kotlin', 'Usar Kotlin', 'use kotlin not python', '', '', '')
  `)

  const buffer = Buffer.from(rawDb.export())
  writeFileSync(dbPath, buffer)
  rawDb.close()

  // Now initDatabase should migrate
  const db = await initDatabase({ dbPath })

  test("migration: listFeedbacks returns migrated data", () => {
    const feedbacks = db.listFeedbacks(10)
    assert(feedbacks.length >= 2, `expected >= 2, got ${feedbacks.length}`)
  })

  test("migration: migrated rule_summary becomes rule", () => {
    const feedbacks = db.listFeedbacks(10)
    const asyncFeedback = feedbacks.find(f => f.raw_feedback === "better use async")
    assert(asyncFeedback !== undefined, "feedback with raw_feedback 'better use async' not found")
    assertEq(asyncFeedback!.rule, "Preferir async/await")
  })

  test("migration: empty workspace becomes 'global'", () => {
    const feedbacks = db.listFeedbacks(10)
    const kotlinFeedback = feedbacks.find(f => f.raw_feedback === "use kotlin not python")
    assert(kotlinFeedback !== undefined, "feedback with raw_feedback 'use kotlin not python' not found")
    assertEq(kotlinFeedback!.workspace, "global")
  })

  test("migration: non-empty workspace preserved", () => {
    const feedbacks = db.listFeedbacks(10)
    const asyncFeedback = feedbacks.find(f => f.raw_feedback === "better use async")
    assert(asyncFeedback !== undefined)
    assertEq(asyncFeedback!.workspace, "/test")
  })

  db.close()
  try { unlinkSync(dbPath) } catch {}
}

// ============================================================
// Run all sync + async tests
// ============================================================
async function main() {
  console.log(`\n${"=".repeat(60)}`)
  console.log("agent-leash v0.3 — Test Suite")
  console.log(`${"=".repeat(60)}`)

  await runDbTests()
  await runMigrationTests()

  await new Promise(resolve => setTimeout(resolve, 100))

  console.log(`\n${"=".repeat(60)}`)
  console.log(`Results: ${passed} passed, ${failed} failed`)
  console.log(`${"=".repeat(60)}`)

  if (failed > 0) {
    process.exit(1)
  }
}

main()
