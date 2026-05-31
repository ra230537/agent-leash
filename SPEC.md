
# agent-leash — Specification v0.1

## 1. Project Overview

**What:** An opencode plugin that lets users give feedback (score + text) to AI agent responses. Feedback is stored locally and will later (v0.2+) be used to inject learned preferences into the system prompt via RAG.

**Name:** agent-leash (npm: `@ra230537/agent-leash`)

**Stack:**
- Language: TypeScript (strict mode)
- Runtime: Node >= 18
- Build: tsup (CJS output for opencode compatibility)
- DB: SQLite via `sql.js` (WASM, no native addons)
- Embeddings: `@xenova/transformers` with `all-MiniLM-L6-v2` (v0.2+, not installed in v0.1)
- License: MIT

**Repo:** `github:ra230537/agent-leash`

---

## 2. Architecture

The plugin hooks into two opencode plugin hooks:

| Hook | Purpose |
|---|---|
| `experimental.text.complete` | Accumulate the assistant's response text in an in-memory cache as it streams |
| `chat.message` | Intercept user messages, detect `//` commands, handle them |

**Plugin type:** Server plugin (exports `server: Plugin`, NOT TUI plugin)

**Entry point:**
```typescript
import type { Plugin } from "@opencode-ai/plugin"

const plugin: Plugin = async (input, options) => {
  const db = await initDatabase(options?.dbPath)
  const cache = new Map<string, CachedExchange>()

  // Load transformer model (v0.2+)

  return {
    "experimental.text.complete": async (input, output) => {
      // Accumulate assistant response text per session
    },
    "chat.message": async (input, output) => {
      // Detect // commands and process feedback
    },
    dispose: async () => {
      // Close DB, clear cache
    },
  }
}

export { plugin }
```

---

## 3. Plugin Hooks — Detailed

### 3.1 `experimental.text.complete`

**Signature (from @opencode-ai/plugin v1.15+):**
```typescript
"experimental.text.complete"?: (
  input: { sessionID: string; messageID: string; partID: string },
  output: { text: string },
) => Promise<void>
```

**Behavior:**
- Fires for each text part as it finishes streaming from the LLM.
- The plugin accumulates `output.text` into a per-session cache.
- Cache structure: `Map<sessionID, { prompt: string, response: string }>`
- Reset the response accumulator when a new `messageID` is detected (new assistant message).

### 3.2 `chat.message`

**Signature:**
```typescript
"chat.message"?: (
  input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string }; messageID?: string; variant?: string },
  output: { message: UserMessage; parts: Part[] },
) => Promise<void>
```

**Behavior:**
- Fires when the user submits a message (before it goes to the LLM).
- The plugin checks if the message text matches a `//` command.
- If yes: process the command, modify `output.parts` in-place to reflect the result, and let the message proceed to the LLM normally.
- If no: also check auto-detection patterns. If matched, silently save feedback (see §7).
- The workspace for the current session is obtained from `input.worktree` (available in `PluginInput`) and stored in the `workspace` column.

**How to modify output.parts (critical implementation detail):**
The `output.parts` array is passed **by reference**. To clear and replace it in a way that affects the caller:
```typescript
// ✅ CORRECT — mutates the original array
output.parts.splice(0, output.parts.length)
output.parts.push(newPart)

// ❌ WRONG — reassigns the local reference, caller still has original
output.parts = [newPart]
```

### 3.3 `dispose`

**Behavior:** Close SQLite connection, clear in-memory cache.

---

## 4. Data Flow — Feedback (`//3 "texto"`)

```
User types: //3 "ficou confuso, organiza em tópicos"
         │
         ▼
chat.message hook fires
         │
         ▼
Plugin detects pattern ^\/\/\s*([1-5])\s+"(.+)"$
         │
         ├── Parses score=3, text="ficou confuso, organiza em tópicos"
         │
         ├── Retrieves cached assistant response from Map<sessionID>
         │   (if cache miss, source_response = ""; source_prompt = "")
         │
         ├── Gets workspace from plugin input (worktree path)
         │
         ├── Inserts into SQLite (single INSERT with all fields):
         │     INSERT INTO lessons
         │       (score, rule, raw_feedback, source_prompt, source_response, workspace, created_at)
         │     VALUES
         │       (3, 'ficou confuso, organiza em tópicos', 'ficou confuso, organiza em tópicos',
         │        'explica coroutines', 'Coroutines são...', '/meu/projeto', datetime('now'))
         │
         ├── Gets the auto-generated id (db.exec("SELECT last_insert_rowid()"))
         │
         ├── Modifies output.parts IN PLACE:
         │     output.parts.splice(0, output.parts.length)
         │     output.parts.push({
         │       type: "text",
         │       id: crypto.randomUUID(),
         │       sessionID: input.sessionID,
         │       messageID: input.messageID,
         │       text: "✅ Feedback #5 registrado (⭐3)"
         │     })
         │
         └── Message proceeds to LLM (LLM sees the confirmation text and may respond briefly)
```

### List flow (`//list`)

```
User types: //list
         │
         ▼
Plugin queries: SELECT id, rule, score, created_at FROM lessons ORDER BY created_at DESC LIMIT 20
         │
         ▼
Builds formatted list string. Modifies output.parts in-place with the list as text.
```

### Delete flow (`//delete 5`)

```
User types: //delete 5
         │
         ▼
Plugin: DELETE FROM lessons WHERE id = 5
Modifies output.parts in-place with confirmation: "🗑️ Feedback #5 deletado."
```

---

## 5. Database Schema

**File location:** `~/.config/opencode/agent-leash/agent-leash.db`

The folder is created automatically on first run if it doesn't exist.

**Table: lessons**

```sql
CREATE TABLE IF NOT EXISTS lessons (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  score       INTEGER NOT NULL CHECK(score >= 1 AND score <= 5),
  rule        TEXT NOT NULL DEFAULT '',
  raw_feedback TEXT NOT NULL,       -- user's original text
  source_prompt  TEXT DEFAULT '',   -- user's original prompt that generated the response
  source_response TEXT DEFAULT '',  -- assistant's response being evaluated
  workspace   TEXT DEFAULT '',      -- workspace path or 'global'
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Index:**
```sql
CREATE INDEX IF NOT EXISTS idx_lessons_workspace ON lessons(workspace);
CREATE INDEX IF NOT EXISTS idx_lessons_created ON lessons(created_at);
```

**Note for v0.2:** An `embedding BLOB` column will be added for vector search.

---

## 6. Feedback Syntax

### 6.1 `//<score> "<text>"` — Feedback with score

```
//3 "ficou confuso, organiza em tópicos"
//5 "perfeito, muito claro"
//1 "resposta errada, não respondeu a pergunta"
```

**Regex:** `^\/\/\s*([1-5])\s+"(.+)"$`
- Score: digit 1-5 only (required). `//0`, `//6`, `//42` are invalid.
- Text: any content inside double quotes (required). Content cannot contain double quotes (no escape).
- Spaces: `//3"text"` (no space) is valid. `// 3 "text"` (space after //) is valid.
- Must be the entire message (start to end).

**Error messages (shown in the modified text part):**
- Score inválido: `"❌ Score inválido: use 1-5. Ex: //3 \"texto\""` — message passes through to LLM normally.
- Texto vazio: `"❌ Texto do feedback vazio. Ex: //3 \"texto\""` — message passes through.
- ID inexistente (delete): `"❌ Feedback #{id} não encontrado."`
- Lista vazia (list): `"📭 Nenhum feedback registrado ainda."`

### 6.2 `//list` — List recent feedbacks

Shows last 20 feedbacks from the current workspace.

**Output format:**
```
📋 Feedbacks (workspace: projeto-x):
  #5 | ⭐3 | 31/05 13:27 | Preferir tópicos
  #4 | ⭐5 | 31/05 13:20 | Perfeito, manter clareza
  #2 | ⭐2 | 31/05 13:15 | Usar Kotlin, não Python
```

If no feedbacks exist: `"📭 Nenhum feedback registrado ainda."`

### 6.3 `//delete <id>` — Delete a feedback

Deletes the lesson with the given ID.

**Output on success:** `"🗑️ Feedback #{id} deletado."`

**Output on error (ID not found):** `"❌ Feedback #{id} não encontrado."`

---

## 7. Auto-Detection (v0.1 basic)

The plugin detects when the user is correcting the assistant based on natural language patterns.

**Trigger patterns** (message starts with):
```
"Na verdade..."
"Na real..."
"Corrigindo..."
"Melhor seria..."
"Mas na verdade..."
```

**Behavior when detected:**
- Captures the current exchange (prompt from cache + response from cache + user's correction text)
- Assigns default score: 3 (needs improvement, since it's a correction)
- Saves to SQLite with `rule = user_text`, `score = 3`, `workspace = current`
- Does NOT modify the user's message — the message continues to the LLM normally
- Does NOT announce the auto-capture (silent — no confirmation text shown)

**Regex:** `^(Na verdade|Na real|Corrigindo|Melhor seria|Mas na verdade)[,:\s]`

**Guardrails (to avoid false positives):**
- Only capture if the user's message is >= 20 characters (short corrections like "Na verdade não" are likely conversational, not feedback).
- Only capture if the cached assistant response exists (non-empty). If cache is empty, skip auto-detection (the user is starting a new topic, not correcting a previous response).
- Only capture if the user's message is NOT a `//` command (already handled above).

**Default is `autoDetect: true` in config. User can disable:**
```jsonc
{ "plugin": ["@ra230537/agent-leash", { "autoDetect": false }] }
```

---

## 8. In-Memory Cache

**Structure:**
```typescript
type CachedExchange = {
  prompt: string       // last user prompt (non-feedback)
  response: string     // accumulated assistant response text
  assistantMessageID: string  // last messageID from text.complete
}

const exchangeCache = new Map<string, CachedExchange>()
```

**Update rules:**
- `chat.message` fires with a non-`//` message → update `cache.prompt` with the user's message text, reset `cache.response = ""`
- `experimental.text.complete` fires → append `output.text` to `cache.response`, update `cache.assistantMessageID`
- `chat.message` fires with `//` → read from cache (don't update prompt)

**Edge case — brand new session, no cached response yet:**
If `cache.response` is empty when feedback is given, store `source_response = ""` and `source_prompt = ""`. The feedback is still saved, just without context.

---

## 9. Configuration (PluginOptions)

The plugin accepts options via opencode.jsonc:

```jsonc
{
  "plugin": [
    "@ra230537/agent-leash",
    {
      "dbPath": "~/.config/opencode/agent-leash/agent-leash.db"
    }
  ]
}
```

| Option | Type | Default | Description |
|---|---|---|---|
| `dbPath` | string | `~/.config/opencode/agent-leash/agent-leash.db` | Path to SQLite database file |
| `autoDetect` | boolean | `true` | Enable auto-detection of correction patterns |

---

## 10. Dependencies (package.json)

```json
{
  "name": "@ra230537/agent-leash",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit",
    "prepublishOnly": "npm run build"
  },
  "peerDependencies": {
    "@opencode-ai/plugin": ">=1.15"
  },
  "dependencies": {
    "sql.js": "^1.11"
  },
  "devDependencies": {
    "typescript": "^5.5",
    "tsup": "^8.3",
    "@opencode-ai/plugin": "^1.15",
    "@types/node": "^20"
  },
  "publishConfig": {
    "access": "public"
  },
  "license": "MIT"
}
```

**Note on dependencies:**
- `@opencode-ai/plugin` is a **peerDependency** (the user already has it installed in `~/.config/opencode`). It's also a devDependency for type-checking during development.
- `sql.js` is a runtime dependency (~300KB gzipped, pure JS + WASM).
- `@xenova/transformers` is NOT a dependency in v0.1. It will be added in v0.2 as an optional dependency.

## 11. Installation

```bash
# 1. Install the plugin package
cd ~/.config/opencode
npm install @ra230537/agent-leash

# 2. Add to opencode.jsonc
# "plugin": ["@ra230537/agent-leash"]

# 3. Restart opencode
opencode
```

**On first load,** the plugin:
1. Creates `~/.config/opencode/agent-leash/` directory (and DB file)
2. Initializes SQLite database with schema (CREATE TABLE IF NOT EXISTS)
3. Registers hooks with opencode

---

## 12. Known Limitations (v0.1)

1. **No message swallowing.** The `chat.message` hook cannot prevent the message from going to the LLM. Instead, the plugin modifies the message text in-place to show status. The LLM may respond to the confirmation text — this is acceptable for v0.1.
2. **No LLM summarization.** The rule is just the raw feedback text. No LLM call to generate a concise rule.
3. **No embeddings / RAG.** `@xenova/transformers` is not loaded in v0.1. No vector search or semantic retrieval.
4. **No system prompt injection.** The `experimental.chat.system.transform` hook is not used in v0.1.
5. **No per-workspace variant syntax.** The `workspace` column is populated with the current workspace path from `input.worktree`, but `//4g` (global) and `//4w` (workspace) syntax variants are not supported yet. All feedback uses the current workspace. `//list` filters by current workspace automatically.
6. **No auto-detection for positive feedback.** Only corrections are auto-captured.
7. **In-memory cache is per-session.** Restarting opencode clears the cache. Misses for new sessions are handled gracefully (empty strings).
8. **No deduplication.** If the user sends `//3 "texto"` twice, two identical lessons are inserted. There is no conflict detection or "last wins" logic (deferred to v0.2).

---

## 13. Future Work (v0.2+)

1. **LLM summarization of feedback** — use `fetch` to call the same provider API directly, generating concise rules from raw feedback.
2. **Embeddings** — load `@xenova/transformers` with `all-MiniLM-L6-v2`, generate embeddings on save, store as BLOB.
3. **RAG injection** — use `experimental.chat.system.transform` to inject relevant rules into the system prompt at session start.
4. **Workspace scoping** — populate `workspace` column and support `//4g "global"` and `//4w "workspace"` variants.
5. **Positive feedback reinforcement** — track patterns of positive feedback, promote to rules after N occurrences.
6. **Proper message swallowing** — explore alternatives (client API?) to prevent the modified message from reaching the LLM.
7. **Stats** — `//stats` command showing total feedbacks, average score, trends over time.
8. **Search** — `//search "termo"` command for filtering feedbacks.
9. **Dashboard** — optional web UI for managing feedbacks.

---

## 14. Gaps & Open Questions for Implementer

These were not fully resolved during the design conversation and need decisions during implementation:

### Gap 1: No LLM summarization API
The opencode plugin SDK does NOT expose a `client.complete()` or direct LLM call method. For v0.1 this is fine (rule = raw feedback). For v0.2, the plugin will need to make direct HTTP `fetch` calls to the provider API (e.g., DeepSeek OpenAI-compatible endpoint). The provider config (base URL, API key, model) should be read from the opencode config or environment.

**Decision needed for v0.2:** Read provider from opencode config via `client.config.get()` or from env vars directly?

### Gap 2: How to modify output.parts effectively
The `chat.message` hook passes `output: { message: UserMessage, parts: Part[] }`. The `parts` array is passed by reference. To modify it in a way that affects the caller:
- Use **mutation**: `output.parts.splice(0, output.parts.length)` then `output.parts.push(newPart)`
- Do NOT use reassignment: `output.parts = [newPart]` — this won't affect the caller

**Verify during implementation:** Does `parts.splice(0)` work, or does the code after the hook use a different reference? Check `prompt.ts` in the opencode source.

### Gap 3: sql.js WASM loading
`sql.js` requires loading a WASM binary. In a Node.js environment, this is typically:
```typescript
import initSqlJs from "sql.js"
const SQL = await initSqlJs()
const db = new SQL.Database()
```

The WASM file needs to be accessible. `sql.js` usually handles this automatically in Node.js, but verify this works when bundled with `tsup`.

### Gap 4: Auto-detection — what about false positives?
The auto-detection patterns (`Na verdade...`, `Corrigindo...`, etc.) are common Portuguese conversational phrases. They may trigger when the user is NOT giving feedback but just continuing the conversation (e.g., "Na verdade, eu também acho que...").

**Mitigation implemented in spec:** Minimum message length >= 20 chars and non-empty cached response before capturing. False positives can be deleted via `//delete <id>`. User can also set `autoDetect: false` in config.

### Gap 5: No undo for auto-detected feedback
If auto-detection captures a false positive, the user can delete it via `//delete <id>`, but there's no "undo" mechanism within the same turn.

### Gap 6: Message ID tracking in text.complete
The `experimental.text.complete` hook provides `messageID`. We need to detect when a NEW assistant message starts (new messageID) vs. continuation of the current one (same messageID, new partID). This determines when to reset the response accumulator.

### Gap 7: Testing
How to test a opencode plugin? Unit tests for SQLite operations, integration tests with a mock opencode server, or manual testing only?

### Gap 8: Error handling for sql.js
What if the DB file is locked, the directory is not writable, or the WASM fails to load? The plugin should fail gracefully (log error, skip feedback saving, don't crash opencode).

### Gap 9: `//` prefix conflict risk
The `//` prefix is currently unused in opencode. But if a future version of opencode uses `//` for something (e.g., block comments), the plugin will conflict. Monitor opencode changelog.

---

## 15. Files to Create

```
agent-leash/
├── package.json          # name: @ra230537/agent-leash, type: module
├── tsconfig.json         # target: ES2022, module: Node16
├── tsup.config.ts        # entry: src/index.ts, format: ['cjs']
├── src/
│   ├── index.ts          # Plugin entry point (default export)
│   ├── db.ts             # SQLite initialization & queries
│   ├── cache.ts          # In-memory exchange cache
│   ├── feedback.ts       # // command parsing & processing
│   ├── detect.ts         # Auto-detection patterns
│   └── types.ts          # Internal types
├── SPEC.md               # This file
├── LICENSE               # MIT
└── .gitignore            # node_modules, dist
```

---

## 16. Implementation Order

1. `package.json`, `tsconfig.json`, `tsup.config.ts`, `.gitignore` — project scaffold
2. `src/types.ts` — internal types (`CachedExchange`, `Lesson`, `PluginOptions`)
3. `src/db.ts` — SQLite init (sql.js WASM loading, CREATE TABLE, CRUD: insert, list, delete)
4. `src/cache.ts` — in-memory exchange cache (Map-based, session-keyed)
5. `src/feedback.ts` — `//` command parser (regex) + processor (routes to db operations)
6. `src/detect.ts` — auto-detection patterns (regex + guardrails)
7. `src/index.ts` — wire everything, register hooks (`chat.message`, `text.complete`, `dispose`)
8. `tsup.config.ts` tweaks if sql.js WASM needs special handling
9. Manual test with opencode
10. `README.md` — installation & usage instructions
11. `LICENSE` — MIT
12. Publish to npm: `npm publish --access public`
