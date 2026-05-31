import { parseMessage, isCommand, buildFeedbackParts, buildListParts, buildDeleteParts, buildErrorParts, processCommand, formatDate as fmtDate } from "./src/feedback.js"
import { createExchangeCache, ensureExchange, updatePrompt, appendResponse, getExchange } from "./src/cache.js"
import { shouldAutoDetect, autoCapture } from "./src/detect.js"
import { initDatabase } from "./src/db.js"
import { FEEDBACK_REGEX, DELETE_REGEX, LIST_REGEX, AUTO_DETECT_REGEX } from "./src/types.js"

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
// 1. Regex Tests
// ============================================================
console.log("\n--- Regex Tests ---")

test("FEEDBACK_REGEX: //3 \"test\"", () => {
  const m = "//3 \"test\"".match(FEEDBACK_REGEX)
  assert(m !== null)
  assertEq(m![1], "3")
  assertEq(m![2], "test")
})

test("FEEDBACK_REGEX: //5 \"hello world\"", () => {
  const m = "//5 \"hello world\"".match(FEEDBACK_REGEX)
  assert(m !== null)
  assertEq(m![1], "5")
  assertEq(m![2], "hello world")
})

test("FEEDBACK_REGEX: // 4 \"spaces\"", () => {
  const m = "// 4 \"spaces\"".match(FEEDBACK_REGEX)
  assert(m !== null)
  assertEq(m![1], "4")
})

test("FEEDBACK_REGEX: //3\"notext\" (no space) valid", () => {
  const m = "//3\"notext\"".match(FEEDBACK_REGEX)
  assert(m !== null)
  assertEq(m![1], "3")
  assertEq(m![2], "notext")
})

test("FEEDBACK_REGEX: //0 \"zero\" matches (validation in parseMessage)", () => {
  const m = "//0 \"zero\"".match(FEEDBACK_REGEX)
  assert(m !== null, "regex now matches any digit, validation in parseMessage")
  assertEq(m![1], "0")
})

test("FEEDBACK_REGEX: //6 \"six\" matches (validation in parseMessage)", () => {
  const m = "//6 \"six\"".match(FEEDBACK_REGEX)
  assert(m !== null, "regex now matches any digit, validation in parseMessage")
  assertEq(m![1], "6")
})

test("FEEDBACK_REGEX: normal text not matched", () => {
  assert("hello world".match(FEEDBACK_REGEX) === null)
})

test("DELETE_REGEX: //delete 42", () => {
  const m = "//delete 42".match(DELETE_REGEX)
  assert(m !== null)
  assertEq(m![1], "42")
})

test("LIST_REGEX: //list", () => {
  assert(LIST_REGEX.test("//list"))
})

test("LIST_REGEX: //list with trailing space", () => {
  assert(LIST_REGEX.test("//list   ") === false) // exact match only
})

test("AUTO_DETECT_REGEX: Na verdade, isso está errado", () => {
  assert(AUTO_DETECT_REGEX.test("Na verdade, isso está errado"))
})

test("AUTO_DETECT_REGEX: Corrigindo: use async/await", () => {
  assert(AUTO_DETECT_REGEX.test("Corrigindo: use async/await"))
})

test("AUTO_DETECT_REGEX: Melhor seria fazer diferente", () => {
  assert(AUTO_DETECT_REGEX.test("Melhor seria fazer diferente"))
})

test("AUTO_DETECT_REGEX: Na real o caminho é outro", () => {
  assert(AUTO_DETECT_REGEX.test("Na real o caminho é outro"))
})

test("AUTO_DETECT_REGEX: Mas na verdade, esqueci de...", () => {
  assert(AUTO_DETECT_REGEX.test("Mas na verdade, esqueci de..."))
})

test("AUTO_DETECT_REGEX: Just 'Na verdade' no colon fails", () => {
  // No colon, comma, or space after the pattern word — still matches because
  // the regex is /^(Na verdade|Na real|...)[,:\s]/i — so bare "Na verdade" followed
  // by a space character fails? No, \s matches space. Let's test:
  assert(AUTO_DETECT_REGEX.test("Na verdade") === false) // needs [,:\s] after
})

// ============================================================
// 2. parseMessage Tests
// ============================================================
console.log("\n--- parseMessage Tests ---")

test("parseMessage: //3 \"good\" -> feedback type", () => {
  const r = parseMessage("//3 \"good\"")
  assertEq(r.type, "feedback")
  if (r.type === "feedback") {
    assertEq(r.score, 3)
    assertEq(r.text, "good")
  }
})

test("parseMessage: //list -> list type", () => {
  const r = parseMessage("//list")
  assertEq(r.type, "list")
})

test("parseMessage: //delete 7 -> delete type", () => {
  const r = parseMessage("//delete 7")
  assertEq(r.type, "delete")
  if (r.type === "delete") assertEq(r.id, 7)
})

test("parseMessage: normal text -> none", () => {
  const r = parseMessage("hello world")
  assertEq(r.type, "none")
})

test("parseMessage: //0 \"bad\" -> error (invalid score)", () => {
  const r = parseMessage("//0 \"bad\"")
  assertEq(r.type, "error")
})

test("parseMessage: //6 \"bad\" -> error (invalid score)", () => {
  const r = parseMessage("//6 \"bad\"")
  assertEq(r.type, "error")
})

// ============================================================
// 3. isCommand Tests
// ============================================================
console.log("\n--- isCommand Tests ---")

test("isCommand: //list", () => assert(isCommand("//list")))
test("isCommand: //3 \"test\"", () => assert(isCommand("//3 \"test\"")))
test("isCommand: //delete 5", () => assert(isCommand("//delete 5")))
test("isCommand: normal text", () => assert(!isCommand("hello world")))
test("isCommand: empty", () => assert(!isCommand("")))
test("isCommand: // with spaces before", () => assert(isCommand("  //list")))

// ============================================================
// 4. Cache Tests — CRITICAL for auto-detection bug
// ============================================================
console.log("\n--- Cache Tests ---")

test("cache: create and get", () => {
  const c = createExchangeCache()
  assert(c instanceof Map)
  assertEq(c.size, 0)
})

test("cache: ensureExchange creates entry", () => {
  const c = createExchangeCache()
  const entry = ensureExchange(c, "session-1")
  assert(entry !== undefined)
  assertEq(entry.prompt, "")
  assertEq(entry.response, "")
  assertEq(c.size, 1)
})

test("cache: updatePrompt sets prompt and clears response", () => {
  const c = createExchangeCache()
  // Simulate: assistant responded first
  ensureExchange(c, "s1")
  appendResponse(c, "s1", "Hello", "msg-1")
  appendResponse(c, "s1", " World", "msg-1")
  assertEq(getExchange(c, "s1")!.response, "Hello World")
  
  // Now user sends a new message
  updatePrompt(c, "s1", "new query")
  assertEq(getExchange(c, "s1")!.prompt, "new query")
  // RESPONSE IS CLEARED — this is the bug for auto-detection!
  assertEq(getExchange(c, "s1")!.response, "")
})

test("cache: appendResponse tracks messageID changes", () => {
  const c = createExchangeCache()
  appendResponse(c, "s1", "Part 1", "msg-1")
  appendResponse(c, "s1", " Part 2", "msg-1")
  assertEq(getExchange(c, "s1")!.response, "Part 1 Part 2")
  
  // New messageID should reset
  appendResponse(c, "s1", "New msg", "msg-2")
  assertEq(getExchange(c, "s1")!.response, "New msg")
})

test("cache: getExchange returns undefined for missing", () => {
  const c = createExchangeCache()
  assert(getExchange(c, "nonexistent") === undefined)
})

// ============================================================
// 5. Auto-Detection Bug Reproduction
// ============================================================
console.log("\n--- Auto-Detection Bug Reproduction ---")

test("BUG: shouldAutoDetect returns false when cache.response is empty", () => {
  const result = shouldAutoDetect("Na verdade, o código está errado e precisa ser corrigido", "")
  assertEq(result, false)
})

test("shouldAutoDetect returns false for short text", () => {
  const result = shouldAutoDetect("Na verdade", "cached response text here")
  assertEq(result, false) // shorter than 20 chars
})

test("shouldAutoDetect returns true for valid correction", () => {
  const result = shouldAutoDetect(
    "Na verdade, o código está errado e precisa ser corrigido urgentemente",
    "cached response text here"
  )
  assertEq(result, true)
})

test("shouldAutoDetect returns false for non-matching text", () => {
  const result = shouldAutoDetect(
    "Can you explain this code to me more clearly please",
    "cached response text here"
  )
  assertEq(result, false)
})

// Simulate the OLD broken flow (auto-detect AFTER updatePrompt)
test("BUG REPRODUCTION (OLD): Full flow — auto-detection fails when updatePrompt runs first", () => {
  const cache = createExchangeCache()
  
  appendResponse(cache, "s1", "A resposta é: use async/await para", "msg-1")
  appendResponse(cache, "s1", " resolver o problema.", "msg-1")
  
  // OLD order: updatePrompt first, then auto-detect
  updatePrompt(cache, "s1", "Na verdade, use Promises em vez de async/await")
  
  const entry = getExchange(cache, "s1")
  assertEq(entry!.response, "", "BUG (old): response was cleared by updatePrompt!")
  const detected = shouldAutoDetect("Na verdade, use Promises em vez de async/await", entry!.response)
  assertEq(detected, false, "BUG (old): auto-detection fails because response is empty!")
})

// Simulate the NEW fixed flow (auto-detect BEFORE updatePrompt)
test("FIX VERIFICATION: Full flow — auto-detection works when it runs before updatePrompt", () => {
  const cache = createExchangeCache()
  
  appendResponse(cache, "s1", "A resposta é: use async/await para", "msg-1")
  appendResponse(cache, "s1", " resolver o problema.", "msg-1")
  
  // NEW order: auto-detect first, then updatePrompt
  const cacheEntry = getExchange(cache, "s1")
  const detected = shouldAutoDetect("Na verdade, use Promises em vez de async/await", cacheEntry!.response)
  assertEq(detected, true, "FIX: auto-detection now works because response is checked BEFORE clearing")
  
  updatePrompt(cache, "s1", "Na verdade, use Promises em vez de async/await")
  assertEq(getExchange(cache, "s1")!.prompt, "Na verdade, use Promises em vez de async/await")
  assertEq(getExchange(cache, "s1")!.response, "")
})

// ============================================================
// 6. buildFeedbackParts Tests
// ============================================================
console.log("\n--- buildFeedbackParts Tests ---")

test("buildFeedbackParts creates valid TextPart", () => {
  const parts = buildFeedbackParts("s1", "m1", "hello")
  assertEq(parts.length, 1)
  assertEq(parts[0].type, "text")
  assertEq(parts[0].text, "hello")
  assertEq(parts[0].sessionID, "s1")
  assertEq(parts[0].messageID, "m1")
  assert(typeof parts[0].id === "string")
  assert(parts[0].id.length > 0)
})

test("buildDeleteParts", () => {
  const parts = buildDeleteParts("s1", "m1", 5)
  assert(parts[0].text.includes("5"))
  assert(parts[0].text.includes("deletado"))
})

test("buildErrorParts", () => {
  const parts = buildErrorParts("s1", "m1", "error message")
  assertEq(parts[0].text, "error message")
})

// ============================================================
// 7. Database Tests (sql.js)
// ============================================================
console.log("\n--- Database Tests ---")

async function runDbTests() {
  const db = await initDatabase({ dbPath: "./test-agent-leash.db" })
  
  test("db: insertLesson returns an id", () => {
    const id = db.insertLesson({
      score: 4,
      rule: "better use async",
      raw_feedback: "better use async/await",
      source_prompt: "how to handle promises",
      source_response: "use .then()",
      workspace: "/test/workspace",
    })
    assert(typeof id === "number")
    assert(id > 0)
  })
  
  test("db: listLessons returns results", () => {
    const lessons = db.listLessons("/test/workspace", 10)
    assert(lessons.length >= 1)
    const last = lessons[0]
    assertEq(last.score, 4)
    assertEq(last.rule, "better use async")
    assertEq(last.workspace, "/test/workspace")
  })

  test("db: listLessons filters by workspace", () => {
    db.insertLesson({
      score: 3,
      rule: "other workspace",
      raw_feedback: "test",
      source_prompt: "",
      source_response: "",
      workspace: "/other/workspace",
    })
    const testLessons = db.listLessons("/test/workspace", 10)
    const allHaveCorrectWorkspace = testLessons.every(l => l.workspace === "/test/workspace")
    assert(allHaveCorrectWorkspace)
  })
  
  test("db: deleteLesson works", () => {
    const id = db.insertLesson({
      score: 1,
      rule: "to delete",
      raw_feedback: "will be deleted",
      source_prompt: "",
      source_response: "",
      workspace: "/test/workspace",
    })
    const deleted = db.deleteLesson(id)
    assertEq(deleted, true)
    const deleted2 = db.deleteLesson(id)
    assertEq(deleted2, false)
  })
  
  test("db: insertLesson with empty fields", () => {
    const id = db.insertLesson({
      score: 5,
      rule: "",
      raw_feedback: "",
      source_prompt: "",
      source_response: "",
      workspace: "",
    })
    assert(typeof id === "number")
    assert(id > 0)
  })
  
  db.close()
  
  // Cleanup
  const fs = await import("node:fs")
  try { fs.unlinkSync("./test-agent-leash.db") } catch {}
}

// ============================================================
// 8. ProcessCommand Tests (with mock DB)
// ============================================================
console.log("\n--- ProcessCommand Tests ---")

function createMockDB(): import("./src/db.js").Database {
  let nextId = 1
  const lessons: any[] = []
  return {
    insertLesson(lesson) {
      const id = nextId++
      const now = new Date().toISOString()
      lessons.push({ id, ...lesson, created_at: now, updated_at: now })
      return id
    },
    listLessons(workspace, limit) {
      return lessons
        .filter(l => l.workspace === workspace)
        .sort((a, b) => b.id - a.id)
        .slice(0, limit)
    },
    deleteLesson(id) {
      const idx = lessons.findIndex(l => l.id === id)
      if (idx === -1) return false
      lessons.splice(idx, 1)
      return true
    },
    close() {},
  }
}

test("processCommand: feedback with cache", () => {
  const db = createMockDB()
  const cacheEntry = { prompt: "how to code", response: "use this pattern", assistantMessageID: "m1" }
  const result = processCommand(
    "//4 \"use async/await\"",
    "s1", "m2", "/workspace",
    db, cacheEntry
  )
  assertEq(result.success, true)
  assert(result.parts.length > 0)
  assert(result.parts[0].text.includes("4"))
  assert(result.parts[0].text.includes("Feedback"))
})

test("processCommand: feedback without cache", () => {
  const db = createMockDB()
  const result = processCommand(
    "//3 \"good\"",
    "s1", "m2", "/workspace",
    db, undefined
  )
  assertEq(result.success, true)
  assert(result.parts[0].text.includes("3"))
})

test("processCommand: //list empty", () => {
  const db = createMockDB()
  const result = processCommand(
    "//list",
    "s1", "m2", "/workspace",
    db, undefined
  )
  assertEq(result.success, true)
  assert(result.parts[0].text.includes("Nenhum"))
})

test("processCommand: //list with data", () => {
  const db = createMockDB()
  db.insertLesson({ score: 5, rule: "perfect", raw_feedback: "perfect", source_prompt: "", source_response: "", workspace: "/ws" })
  const result = processCommand(
    "//list",
    "s1", "m2", "/ws",
    db, undefined
  )
  assertEq(result.success, true)
  assert(result.parts[0].text.includes("perfect"))
})

test("processCommand: //delete existing", () => {
  const db = createMockDB()
  const id = db.insertLesson({ score: 3, rule: "meh", raw_feedback: "meh", source_prompt: "", source_response: "", workspace: "/ws" })
  const result = processCommand(
    `//delete ${id}`,
    "s1", "m2", "/ws",
    db, undefined
  )
  assertEq(result.success, true)
  assert(result.parts[0].text.includes(`${id}`))
})

test("processCommand: //delete non-existing", () => {
  const db = createMockDB()
  const result = processCommand(
    "//delete 999",
    "s1", "m2", "/ws",
    db, undefined
  )
  assertEq(result.success, false)
  assert(result.parts[0].text.includes("não encontrado"))
})

test("processCommand: invalid score (error)", () => {
  const db = createMockDB()
  const result = processCommand(
    "//7 \"bad\"",
    "s1", "m2", "/ws",
    db, undefined
  )
  assertEq(result.success, false)
})

test("processCommand: non-command returns empty parts", () => {
  const db = createMockDB()
  const result = processCommand(
    "hello world",
    "s1", "m2", "/ws",
    db, undefined
  )
  assertEq(result.success, false)
  assertEq(result.parts.length, 0)
})

// ============================================================
// Run all sync + async tests
// ============================================================
async function main() {
  console.log(`\n${"=".repeat(60)}`)
  console.log("agent-leash — Test Suite")
  console.log(`${"=".repeat(60)}`)
  
  await runDbTests()
  
  // Wait a bit for async tests
  await new Promise(resolve => setTimeout(resolve, 100))
  
  console.log(`\n${"=".repeat(60)}`)
  console.log(`Results: ${passed} passed, ${failed} failed`)
  console.log(`${"=".repeat(60)}`)
  
  if (failed > 0) {
    process.exit(1)
  }
}

main()
