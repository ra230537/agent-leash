# agent-leash — Specification v0.3

## 1. Project Overview

**What:** An opencode plugin that lets users give feedback (`# texto`) to train the AI agent's behaviour over time. Feedback is stored locally and persisted as a markdown preference file that gets injected into the system prompt.

**Core insight from v0.2:** Embeddings, scores, auto-detection, and per-prompt RAG injection were the wrong abstractions. Most preferences are **global** (apply to everything), not punctual. Feedback must be **conscious** (explicit `#` command), not guessed by heuristics. The behaviours must be **in harmony with skills**, not injected before every prompt at high latency.

**Philosophy shift:**
- v0.2: embedding → similarity search → inject into every prompt (latency, conflicts)
- v0.3: save → summarise → write to `preferences.md` → read at system prompt assembly (~0ms)

## 2. Decisions Record (from grilling session)

| Decision | Choice |
|---|---|
| Unit of feedback | `raw_feedback` (user text) + `rule` (LLM-summarised, async) |
| Score | Removed — not meaningful for global preferences |
| Embedding | Removed — not needed for always-on rules |
| Source context | Removed — `source_prompt` / `source_response` unnecessary |
| Syntax | `# <texto>` — everything after `#` is raw_feedback |
| Scope | Global only (workspace field kept for future use) |
| Auto-detection | Removed — feedback must be explicit |
| Exchange cache | Removed — no more RAG, no need to track prompt/response |
| Injection strategy | `preferences.md` on disk → read and append via `experimental.chat.system.transform` |
| Preference file | `~/.config/opencode/agent-leash/preferences.md` |
| Summarisation | `input.client.session.prompt()` on a temp session (async — works with any provider including built-in `opencode`) |
| Table name | `feedbacks` (migrated from `lessons`) |
| Rebuild trigger | Every `#` command + when async summarisation completes |

## 3. Architecture

The plugin hooks into two opencode hooks:

| Hook | Purpose |
|---|---|
| `chat.message` | Detect `#` commands (feedback, list, delete), process them |
| `experimental.chat.system.transform` | Read `preferences.md` and append to system prompt |

**Plugin type:** Server plugin (exports `server: Plugin`, NOT TUI plugin)

**Entry point:**
```typescript
import type { Plugin } from "@opencode-ai/plugin"

const plugin: Plugin = async (input, options) => {
  const db = await initDatabase(options)
  await rebuildPreferencesFile(db)     // ensure file exists on startup

  return {
    "chat.message": async (input, output) => {
      // Detect # commands: feedback, list, delete
    },
    "experimental.chat.system.transform": async (input, output) => {
      // Read preferences.md and append to output.system
    },
    dispose: async () => {
      db.close()
    },
  }
}

export { plugin as server }
```

## 4. Database Schema

**File location:** `~/.config/opencode/agent-leash/agent-leash.db`

```sql
CREATE TABLE IF NOT EXISTS feedbacks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_feedback TEXT NOT NULL,
  rule         TEXT DEFAULT NULL,
  workspace    TEXT DEFAULT 'global',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feedbacks_workspace ON feedbacks(workspace);
CREATE INDEX IF NOT EXISTS idx_feedbacks_created ON feedbacks(created_at);
```

**Migration from v0.2 (`lessons` → `feedbacks`):**
1. Check if table `lessons` exists via `SELECT name FROM sqlite_master WHERE type='table' AND name='lessons'`
2. If yes: `ALTER TABLE lessons RENAME TO feedbacks`
3. Check columns via `PRAGMA table_info(feedbacks)`
4. `ALTER TABLE feedbacks DROP COLUMN score` (if exists — sql.js supports DROP COLUMN? Check. If not, recreate table)
5. `ALTER TABLE feedbacks DROP COLUMN embedding`
6. `ALTER TABLE feedbacks DROP COLUMN rule_summary` → rename to `rule`? Actually simpler: leave `rule_summary` as-is and alias it as `rule` in queries. Or `ALTER TABLE feedbacks RENAME COLUMN rule_summary TO rule` (sql.js supports this? Check at implementation).

**Simpler approach for migration:** Create new `feedbacks` table, copy rows from `lessons` with only the kept columns, drop `lessons`.

## 5. Feedback Syntax

### 5.1 `# <texto>` — Save feedback

```
# ficou confuso, organiza em tópicos
# use Kotlin em vez de Python
```

**Parsing:**
```
^#\s*(.+)$                    → feedback, raw_feedback = capture group 1 trimmed
^#list$                       → list all feedbacks
^#delete\s+(\d+)$            → delete feedback with given ID
```

If the trimmed text after `#` is empty → error: `"❌ Feedback vazio. Ex: # texto"`

### 5.2 `#list` — List recent feedbacks

Shows last 20 feedbacks, ordered by `created_at DESC`.

**Output format:**
```
📋 Feedbacks:
  #5 | Preferir tópicos
  #4 | Usar Kotlin, não Python
  #2 | Sempre responder em português
```

If no feedbacks exist: `"📭 Nenhum feedback registrado ainda."`

### 5.3 `#delete <id>` — Delete a feedback

Deletes the feedback with the given ID, then rebuilds `preferences.md`.

**Output on success:** `"🗑️ Feedback #{id} deletado."`
**Output on error (not found):** `"❌ Feedback #{id} não encontrado."`

## 6. Data Flow — Feedback Save

```
User: # use Kotlin em vez de Python
          │
          ▼
chat.message hook fires
          │
          ▼
Parse command → not #list, not #delete → it's feedback
          │
          ▼
[SQUASH] raw_feedback = "use Kotlin em vez de Python"
          │
          ▼
[SYNC] INSERT INTO feedbacks (raw_feedback, rule, workspace)
       VALUES ("use Kotlin em vez de Python", NULL, 'global')
          │
          ▼
[SYNC] rebuildPreferencesFile(db)
       → SELECT id, rule, raw_feedback FROM feedbacks WHERE rule IS NOT NULL
       → Write ~/.config/opencode/agent-leash/preferences.md
          │
          ▼
[SYNC] Replace output.parts with:
       "✅ Feedback #42 registrado"
          │
          ▼
Message proceeds to LLM (LLM sees only the confirmation)
          │
          ▼
[ASYNC] Generate rule from raw_feedback:
        1. input.client.session.create() → temp session
        2. input.client.session.prompt() → send summarisation prompt
        3. Extract text from parts → rule string
        4. input.client.session.delete() → clean up temp session
        5. UPDATE feedbacks SET rule = ?, updated_at = datetime('now') WHERE id = ?
        6. rebuildPreferencesFile(db)  // second time, now with the rule
```

**Note on step 2 (LLM call):**

The summarisation uses `input.client.session.prompt()` — creates a temporary session, sends a summarisation prompt, extracts the response, and deletes the session. This works with any opencode provider (including the built-in `opencode` provider which needs no external API key — it uses free-tier models like `gpt-5-nano` via `apiKey: "public"`).

```typescript
const sessionRes = await input.client.session.create()
const sessionID = sessionRes.data.id

const promptRes = await input.client.session.prompt({
  path: { id: sessionID },
  body: {
    system: "You are a preference extractor. Given a user's raw feedback about an AI assistant's response, summarise it into a concise, actionable rule (max 15 words) that the assistant should follow. Focus on the core instruction, ignore emotions and filler. Output ONLY the rule, no quotes, no prefix.",
    parts: [{ type: "text", text: `Raw feedback: "${raw_feedback}"` }],
  },
})

const rule = (promptRes.data.parts ?? [])
  .filter((p) => p.type === "text" && "text" in p)
  .map((p) => p.text)
  .join("")
  .trim()

await input.client.session.delete({ path: { id: sessionID } })
```

If summarisation fails (network, provider error, etc.) → `rule` stays NULL, feedback still saved, preferences.md rebuilt without it.

## 7. Preferences File

### 7.1 Location

`~/.config/opencode/agent-leash/preferences.md`

### 7.2 Format

```markdown
## Agent Preferences

- Prefira organizar respostas em tópicos
- Use Kotlin em vez de Python para exemplos
- Sempre responda em português
```

Bullet points, one per `rule`. Sorted by `created_at DESC` (most recent first).

If no feedbacks have `rule` set yet → file contains only the header (or is empty/skip).

### 7.3 System Prompt Injection

In `experimental.chat.system.transform`:

```
Hook fires with output.system: string[]
          │
          ▼
Read ~/.config/opencode/agent-leash/preferences.md
If file doesn't exist or is empty → return
          │
          ▼
Append content to output.system array:
  output.system.push(content)
```

The opencode system prompt assembly already runs this hook after composing: `[agent prompt, env, instructions, skills]`. Our content is appended after skills, so it's visible to the LLM but doesn't conflict.

### 7.4 Rebuild Trigger

The file is rebuilt when:
1. Plugin initialises (ensure file exists, may be empty)
2. After every `# <texto>` command (rules that exist so far)
3. After async summarisation completes (now includes the new rule)
4. After `#delete N` (remove deleted rule)

**Implementation:** `rebuildPreferencesFile(db)`:
1. `SELECT rule FROM feedbacks WHERE rule IS NOT NULL ORDER BY created_at DESC`
2. Format as markdown bullet list
3. Write to `~/.config/opencode/agent-leash/preferences.md`
4. If no rules exist → write empty file (just header or empty string)

## 8. Commands Summary

| Command | Action |
|---|---|
| `# texto` | Save feedback, async summarise |
| `#list` | Show last 20 feedbacks |
| `#delete N` | Delete feedback N, rebuild preferences |

Error messages:
- Empty feedback: `"❌ Feedback vazio. Ex: # texto"`
- Delete not found: `"❌ Feedback #{id} não encontrado."`
- List empty: `"📭 Nenhum feedback registrado ainda."`
- Unknown command (starts with `#` but doesn't match): treated as feedback

## 9. Error Handling / Degradação Graciosa

| Failure | Behaviour |
|---|---|
| DB init fails | Plugin logs error, skips all operations, doesn't crash opencode |
| SQL insert fails | Feedback not saved, error logged, message unchanged |
| LLM session.prompt() fails | rule stays NULL, feedback still saved |
| LLM summarisation fails | rule stays NULL, feedback still saved |
| preferences.md write fails | Logged, next rebuild retries |
| preferences.md read fails | Silently skip injection |
| System prompt hook throws | Caught by opencode's Effect wrapper |

## 10. Package.json Changes

```jsonc
{
  "dependencies": {
    "sql.js": "^1.11"
    // REMOVED: @xenova/transformers (no more embeddings)
    // REMOVED: @opencode-ai/sdk (no longer needed as direct dep;
    //           input.client types come from @opencode-ai/plugin peerDep)
  },
  "devDependencies": {
    "typescript": "^5.5",
    "tsup": "^8.3",
    "@opencode-ai/plugin": "^1.15",
    "@types/node": "^20"
  },
  "peerDependencies": {
    "@opencode-ai/plugin": ">=1.15"
  }
}
```

## 11. Initialization Flow

On plugin load:
1. Init SQLite database (migrate from `lessons` to `feedbacks` if needed)
2. Ensure `~/.config/opencode/agent-leash/` directory exists
3. Call `rebuildPreferencesFile(db)` — ensure `preferences.md` exists
4. Register hooks

## 12. Known Limitations (v0.3)

1. **Manual edits to `preferences.md` will be overwritten** on next rebuild. The plugin owns this file. Edit feedbacks via `#` commands or `#delete`.
2. **No per-workspace scoping.** All feedbacks are global. Workspace column exists for future use but is always 'global'.
3. **No positive/negative distinction.** All feedbacks are treated as instructions, no reinforcement logic.
4. **No deduplication.** Same feedback sent twice creates two entries. Future: `#list` to see duplicates, `#delete` to remove.
5. **Summarisation uses the built-in `opencode` provider.** The opencode provider works out of the box (free-tier models, no external API key needed). If summarisation still fails, `rule` stays NULL and the raw_feedback is omitted from preferences.md until the next successful summarisation.
6. **`#list` and `#delete` consume a message turn.** The confirmation text goes to the LLM, which may respond briefly. This is acceptable — no message swallowing API exists.
7. **`#` prefix could conflict** if a future opencode version uses `#` for something. Monitor changelog.

## 13. Resolved Implementation Details

These were explored in the opencode source code and resolved during design:

### R1: Summarisation uses `input.client.session.prompt()` — works with any provider

The summarisation does NOT use direct HTTP fetch. Instead it uses the opencode SDK client's `session.prompt()` method, which:

1. Creates a temporary session via `POST /session` (REST)
2. Sends a prompt with system + user text via `POST /session/{id}/message`
3. Extracts the text response from the returned parts
4. Deletes the temporary session via `DELETE /session/{id}`

This works with **any configured provider**, including the built-in `opencode` provider which requires no external API key. The opencode provider uses free-tier models (like `gpt-5-nano`) via `apiKey: "public"` when no key is configured.

If summarisation fails (network error, provider unavailable, etc.), `rule` stays `NULL` and `raw_feedback` is used as fallback in the preferences file.

### R2: The `opencode` provider is built-in and needs no external API key

The opencode source defines `opencode` as a first-class provider ID (at `packages/core/src/provider.ts:10` alongside `anthropic`, `openai`, etc.). Its custom handler (`packages/opencode/src/provider/provider.ts:178`) checks for an API key — if absent, it sets `apiKey: "public"` and enables only free-tier models (`gpt-5-nano`, `big-pickle`, `kimi-k2.5-free`).

This means `input.client.session.prompt()` works out of the box for all users, regardless of whether they have external API keys. No special handling needed — the session.prompt() approach delegates to whatever provider the user has configured.

### R3: sql.js supports `ALTER TABLE DROP COLUMN`

sql.js **1.14.1** embeds **SQLite 3.49.1**, which is well past 3.35.0 (the version that added `DROP COLUMN`). The migration from `lessons` to `feedbacks` can use:

```sql
ALTER TABLE lessons RENAME TO feedbacks;
ALTER TABLE feedbacks DROP COLUMN score;
ALTER TABLE feedbacks DROP COLUMN embedding;
ALTER TABLE feedbacks DROP COLUMN rule_summary;  -- orphaned, will be recreated via migration
ALTER TABLE feedbacks DROP COLUMN source_prompt;
ALTER TABLE feedbacks DROP COLUMN source_response;
```

Or, simpler and safer: create the new `feedbacks` table, `INSERT INTO feedbacks SELECT id, raw_feedback, NULL, workspace, created_at, updated_at FROM lessons`, then `DROP TABLE lessons`.

### R4: Testing approach

The project already has a custom test runner in `test.ts` (546 lines) executed via `tsx`. No Jest/Vitest migration needed. Tests to update/create:
- **Regex/parsing tests**: new syntax (`# texto`, `#list`, `#delete N`)
- **Database tests**: new schema (`feedbacks`), migration from `lessons`
- **`rebuildPreferencesFile` tests**: verify file content after inserts/deletes
- **Command tests**: `processCommand` with mock DB

Run with: `npm test` (already configured).

## 14. Files to Change

```
src/
├── index.ts       # REWRITE — remove text.complete, system.transform reads file,
│                  #          chat.message simplified (no RAG, no auto-detect)
├── db.ts          # REWRITE — new schema (feedbacks), migration from lessons,
│                  #          remove searchSimilar, updateEmbedding, updateRuleSummary
├── cache.ts       # DELETE — no more exchange cache
├── embed.ts       # DELETE — no more embeddings
├── detect.ts      # DELETE — no more auto-detection
├── feedback.ts    # REWRITE — simplified parsing (# texto, #list, #delete)
│                  #          no score, no buildFeedbackParts complexity
├── summarize.ts   # REFACTOR — keep session.prompt() approach, remove internalSessionIDs hack
├── types.ts       # REWRITE — simplified types, removal of score/embedding types
├── part-types.ts  # DELETE — no longer needed (simpler inline parts)
├── logger.ts      # KEEP — unchanged
├── sql.js.d.ts    # KEEP — unchanged
├── test.ts        # UPDATE — tests for new schema and commands
└── SPEC-v0.3.md   # THIS FILE
```
