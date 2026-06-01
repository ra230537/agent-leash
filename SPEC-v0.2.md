# agent-leash — Specification v0.2

## 1. Overview

**Goal:** Close the RAG loop — feedback → summarization → embeddings → retrieval → system prompt injection.

**v0.1 already has:** SQLite storage, `#` command parsing, auto-detection, in-memory exchange cache.

**v0.2 adds:**
1. LLM summarization of raw feedback into concise rules
2. Local embeddings (`@xenova/transformers` + `all-MiniLM-L6-v2`)
3. RAG retrieval (cosine similarity full-scan)
4. System prompt injection via `experimental.chat.system.transform`

---

## 2. Dependencies (package.json)

```jsonc
{
  "dependencies": {
    "sql.js": "^1.11",
    "@xenova/transformers": "^2.17"   // NEW
  }
}
```

`@xenova/transformers` is a standard dependency (not optional). The model weights are downloaded on first use and cached locally.

---

## 3. Database Schema

```sql
CREATE TABLE IF NOT EXISTS lessons (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  score         INTEGER NOT NULL CHECK(score >= 1 AND score <= 5),
  rule          TEXT NOT NULL DEFAULT '',          -- raw feedback text
  rule_summary  TEXT DEFAULT NULL,                 -- LLM-summarized rule (v0.2)
  raw_feedback  TEXT NOT NULL,
  source_prompt   TEXT DEFAULT '',
  source_response TEXT DEFAULT '',
  embedding     BLOB DEFAULT NULL,                 -- 384 float32 bytes (v0.2)
  workspace     TEXT DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lessons_workspace ON lessons(workspace);
CREATE INDEX IF NOT EXISTS idx_lessons_created ON lessons(created_at);
```

**Migration note:** If changing from v0.1 schema, use `PRAGMA table_info(lessons)` to detect missing columns and `ALTER TABLE ADD COLUMN` for `embedding` and `rule_summary`.

---

## 4. Embedding Engine (`src/embed.ts`)

**File: `src/embed.ts`**

```typescript
import { pipeline } from "@xenova/transformers"

let extractor: any = null

async function getExtractor(): Promise<any> {
  if (!extractor) {
    extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")
  }
  return extractor
}

export async function generateEmbedding(text: string): Promise<Float32Array> {
  const ext = await getExtractor()
  const result = await ext(text, { pooling: "mean", normalize: true })
  return Object.values(result.data) as Float32Array  // 384 floats
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
```

**Behavior:**
- Model loads lazily on first call to `generateEmbedding()`
- If loading fails (no internet, corrupted cache), the error is caught and RAG is silently disabled for the session
- `generateEmbedding` returns a `Float32Array` of 384 normalized floats
- `cosineSimilarity` returns a value in [-1, 1]

---

## 5. Summarization Engine (`src/summarize.ts`)

**File: `src/summarize.ts`**

```typescript
export async function summarizeFeedback(raw_feedback: string): Promise<string | null>
```

**Config:** Provider config is read from env vars:
- `DEEPSEEK_API_KEY` → uses `https://api.deepseek.com/v1`
- `OPENAI_API_KEY` → uses `https://api.openai.com/v1`
- `ANTHROPIC_API_KEY` → uses `https://api.anthropic.com/v1`
- Falls back to first found. If none, returns `null`.

**Endpoint call:**
```
POST {baseURL}/chat/completions
Authorization: Bearer ${apiKey}

{
  "model": model,
  "messages": [
    { "role": "system", "content": "You are a preference extractor. Given a user's raw feedback about an AI assistant's response, summarize it into a concise, actionable rule (max 15 words) that the assistant should follow. Focus on the core instruction, ignore emotions and filler." },
    { "role": "user", "content": "Raw feedback: \"{raw_feedback}\"" }
  ],
  "max_tokens": 60,
  "temperature": 0.3
}
```

Supported models per provider:
| Provider | Model |
|---|---|
| DeepSeek | `deepseek-chat` |
| OpenAI | `gpt-4o-mini` |
| Anthropic | `claude-3-haiku-20240307` |

---

## 6. Data Flow — Feedback Save (v0.2)

```
User: #3 "ficou confuso, organiza em tópicos"
         │
         ▼
chat.message hook fires
         │
         ▼
Detect # command → parse #3 "texto"
         │
         ▼
  [SYNC] INSERT into lessons with:
    - raw_feedback, score, rule, rule_summary=NULL, embedding=NULL
    - source_prompt (from cache), source_response (from cache)
    - workspace (from input.worktree)
         │
         ▼
  [SYNC] Get last_insert_rowid()
         │
         ▼
  [SYNC] Replace output.parts with:
    "✅ Feedback #{id} registrado (⭐{score})"
    (message proceeds to LLM with just this text)
         │
         ▼
  [ASYNC] Generate embedding → UPDATE lessons SET embedding = ? WHERE id = ?
         │
         ▼
  [ASYNC] Call LLM summarization → UPDATE lessons SET rule_summary = ? WHERE id = ?
         │
         ▼
  (User sees confirmation immediately; data fills in behind)
```

### Auto-detect flow (v0.2)

Same steps but:
- No confirmation text shown (message unchanged)
- Score is always 3
- Embedding + summarization still happen async

---

## 7. Data Flow — RAG Injection

### 7.1 `chat.message` hook (for normal prompts, not `#` commands)

```
User: "explique coroutines em Kotlin"
         │
         ▼
chat.message fires
         │
         ▼
Not a # command → check auto-detect → not auto-detect
         │
         ▼
Generate embedding of user's prompt text
(if model fails to load, skip RAG, continue normally)
         │
         ▼
Full-scan SELECT from lessons WHERE workspace = current OR workspace = '' OR NULL
For each row with non-NULL embedding:
  Calculate cosineSimilarity(userEmbedding, row.embedding)
         │
         ▼
Sort by similarity DESC
Deduplicate by rule_summary ?? rule text (Set-based)
Take top 10
         │
         ▼
Store in session cache: sessionCache[sessionID].pendingRules = [...]
         │
         ▼
Update cache prompt (normal v0.1 behavior)
```

### 7.2 `experimental.chat.system.transform` hook

```
Hook fires with output.system: string[]
         │
         ▼
Read pendingRules from session cache
         │
         ▼
If pendingRules.length === 0 → do nothing
         │
         ▼
If pendingRules.length > 0:
  Build XML block:
    <agent-leash feedback="">
      {for each rule}
      {rule_summary ?? rule} (score: {score})
      {/for}
    </agent-leash>
         │
         ▼
Append to output.system array:
  output.system.push(block)
         │
         ▼
Clear pendingRules from cache (one-shot per exchange)
```

**Result:** LLM receives the system prompt with relevant past feedback injected.

---

## 8. In-Memory Cache Update

```typescript
type InjectedRule = {
  rule: string
  rule_summary: string | null
  score: number
  similarity: number
}

type CachedExchange = {
  prompt: string
  response: string
  assistantMessageID: string
  pendingRules: InjectedRule[]   // NEW
}
```

**Lifecycle of `pendingRules`:**
- Set by `chat.message` after RAG query (for normal prompts only)
- Read and cleared by `experimental.chat.system.transform`
- If transform hook doesn't fire (edge case), next normal prompt overwrites

---

## 9. Error Handling / Degradação Graciosa

| Failure | Behavior |
|---|---|
| Model load fails | RAG disabled silently. Feedback saves without embedding |
| LLM summarization fails | `rule_summary` stays `NULL`. `rule` (raw) is used as fallback |
| Embedding generation fails | Feedback saves without embedding. Not returned by RAG |
| RAG query SQL error | Skip injection, message proceeds normally |
| System prompt hook throws | Already caught by opencode's Effect wrapper |

Every operation is wrapped in `try/catch` with `console.error` logging. The plugin never blocks the user's message flow.

---

## 10. Dependencies

```jsonc
{
  "dependencies": {
    "sql.js": "^1.11",
    "@xenova/transformers": "^2.17"
  }
}
```

---

## 11. Files to Change

```
src/
├── index.ts       # + experimental.chat.system.transform, + RAG query in chat.message
├── db.ts          # + ADD COLUMN migration, + searchSimilar()
├── cache.ts       # + pendingRules in CachedExchange
├── types.ts       # + InjectedRule type, # prefix regexes
├── embed.ts       # NEW — @xenova/transformers wrapper
└── summarize.ts   # NEW — LLM summarization via fetch
```

---

## 12. Known Limitations (v0.2)

1. **No syntax for scoping.** `#4g "global"` and `#4w "workspace"` are not supported. All feedback uses current workspace. RAG searches workspace OR global.
2. **No positive feedback reinforcement.** Score 5 feedbacks are treated identically to score 3.
3. **No message swallowing.** The modified `output.parts` still goes to the LLM.
4. **No cache for RAG.** Every prompt generates an embedding and does a full scan.
5. **Full-scan only.** No vector index. Acceptable for < 10000 lessons.
6. **No `#stats` or `#search` commands.** Deferred to v0.3.
7. **Prefix `#`.** NOT `//` as originally spec'd. `#` was chosen for better usability during beta.
