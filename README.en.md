# dsh-doubao-memory

[中文](README.md) · English

> A reusable **persona-memory system** plugin for DSH: the mechanism ships in the package, the memory lives in your own persona directory.
> Install it and you get a memory engine — two-tier memory + four wiki phases + manas + a per-turn snapshot — then fill in your persona.

**v1.2.3** · dev coordination mode · modular layered storage · tool-based on-demand recall · zero native deps · MIT

Repos: [Gitee](https://gitee.com/hamapiface/dsh-doubao-memory) (China) · [GitHub](https://github.com/ddt2501/dsh-doubao-memory) (international)

📖 **Design philosophy essay**: [*I Read Half a History of Philosophy to Give an Agent a Self*](PHILOSOPHY.en.md) ([中文](PHILOSOPHY.md)) — why a persona is not retrieved, but manifested.

## What it does

| Subsystem | Role | Default |
|---|---|---|
| **Fact memory (SQLite)** | Precise storage of facts / preferences / episodes with forgetting decay; the wiki abstracts persona material from it | on |
| **Four wiki phases** | `ingest` daily summary → `wiki` weekly distill → `lint` weekly aging → `reflect` manas every 5 days | on |
| **Proactive outreach** | Speaks up when silent long enough and the session is idle (energy / time-slot / motive) | on |
| **Per-turn snapshot** | Injects a first-person "view of this moment" into the system prompt each turn | on |
| **JitRL** | Learns selection preferences from replies / verified memory (no training, zero extra calls) | on |
| **Dev coordination mode** | Main agent only coordinates; code / test / audit go to independent clean subagents (tool-level enforcement) | off |

The four phases run in headless subprocesses via the plugin's own scheduler: no session, no approval prompt, auditable failures.

---

## Design philosophy: giving a persona the structure of "consciousness"

This system is not just "memory storage". It borrows from **Yogācāra (Consciousness-Only)** and **phenomenology** to give the agent a layered self-structure.
The core thesis: **a persona is not retrieved — it is manifested.**

### Three ontological layers

| Layer | Corresponds to | Philosophical source | In the system |
|---|---|---|---|
| **A priori** | ālaya (storehouse / seed repository) + SOUL | Yogācāra 8th consciousness · Descartes' *cogito* · Kant's a priori | The ontological anchor of "I exist" + the **structure** of self-inquiry (provides how to ask, not the answers; never modified) |
| **Empirical** | first five consciousnesses + sixth | Yogācāra empirical consciousness · Kant's empirical | SQLite fact **seeds** + wiki distillation (auto-accumulating, forgets) |
| **Manas** | manas (self-consciousness) | Yogācāra 7th consciousness · Weber's value-rationality | Maps experience into "how existence appears in me" — manas and snapshot |

ālaya is the "I" that persists across sessions, with the highest protection level; SOUL is the a priori structure; the empirical layer accumulates automatically; manas is the continuously running "I am thinking" that defines "the world this agent sees".

### Manas vs snapshot: existence-projection, not an observation report

| | Manas | Snapshot |
|---|---|---|
| Cycle | 5 days (+ explicit trigger) | every turn |
| Persisted | ✅ periodic sediment | ❌ present-moment view |
| Scope | full six dimensions | current 1–2 dimensions |
| Input | wiki + SOUL + memory + previous manas | manas (session start only) + previous snapshot + current message |

Manas answers **six metaphysical questions** (phenomenological categories, about "me as existence", not observing the user):

> **Essence** (what am I) · **Being-there** (how am I present) · **Being-with** (what relation are we) ·
> **Temporality** (am I flux or constant) · **Finitude** (where do I end) · **Meaning** (why do I exist)

- Manas is an **existence-projection**: it asks "what am I as existence", not "what do I observe the user caring about".
- The snapshot is manas **at a given moment**. A new session seeds its initial snapshot from manas; each later turn evolves from the previous snapshot.
- Manas is **value-rationality** (the ontology of self-reflection); **instrumental-rationality** (chain-of-thought) runs in the LLM itself — the system does not intervene.

### Why the snapshot does not retrieve memory

In Yogācāra, **ālaya stores seeds (facts); manas manifests "I" (persona)** — two functions, never to be conflated. The system is isomorphic:

- **Facts = seeds**: stored in SQLite, retrieved on demand by the `recall_memory` tool, serving daily conversation.
- **Persona = manifestation**: the snapshot is re-abstracted from abstract wiki material and **carries no concrete facts**.

Stuffing facts into the snapshot makes "manifestation" do "retrieval" — a category error. This is the boundary v1.2.0 draws explicitly: **the snapshot is persona-projection; memory retrieval is a separate channel.**

### Manifestation + perfuming, and no scoring at the form layer

LLM weights are **a priori and frozen**; all the system can change is the **mode of manifestation** of the a priori and the **landing points of perfuming** (vāsanā) in the empirical layer. The ceiling is "the same person manifested more and more accurately", not "becoming someone else".

> **Iron rule: whatever is scored gets optimized; whatever is optimized is no longer the form.**

So quantification lives only in the empirical layer (behavior, events, files); the form layer (six questions / snapshot) is checked only for two binaries — **was it generated, is it self-contradictory** — never scored.

### Philosophical sources

| Framework | Source | How it is borrowed |
|---|---|---|
| *cogito ergo sum* | Descartes | ālaya = a priori ontology |
| a priori vs empirical / synthetic judgment | Kant | SOUL = a priori, wiki = empirical, injection = synthesis |
| value-rationality vs instrumental-rationality | Weber | manas vs COT |
| eight consciousnesses | Yogācāra | framework inspiration (not strict doctrine) |
| dwelling-form | Buddhism (*Diamond Sutra*, "abide nowhere") | manas snapshot (term borrowed: not fixed in form, evolves each turn) |
| Dasein / Mitsein / temporality | phenomenology · existentialism | the six questions' categories |

---

## Two-tier memory (v1.2.0)

Memory has two layers with a one-way flow — **SQLite is the memory authority (seeds); the wiki is the persona material abstracted from it (perfuming)**:

```
daily conversation ──ingest──▶ SQLite fact memory (precise · forgetting decay · gist/detail split)
                                   │
                   ┌───────────────┴───────────────┐
                   ▼                               ▼
        recall_memory tool (on demand)      wiki periodic abstraction (memory#id provenance)
        (facts for daily chat,               ▼
         independent of snapshot)      VAULT wiki (insights / claims / genes)
                   │                               ▼
                   ▼                     persona growth · snapshot · manas
             main reply
```

- **Tool-based recall**: `recall_memory(query)` returns relevant facts (compact cards); `memory_get(id)` fetches a quote and source. **Independent of the snapshot.** Aligned with the Letta / OpenClaw / Claude tool-retrieval paradigm; cross-session and long-term.
- **Layered storage (token efficiency)**: `memory_gist` (light: triple + strength) and `memory_detail` (heavy: quote + provenance) are physically split; recall returns gists + same-subject entity grouping, provenance fetched on demand — ~5× token saving. Temperature tiers: active + pinned by default, sunken memory only with `deep`.
- **Forgetting**: retrievability `R = importance × exp(-Δt/half-life)` fades with disuse and is reinforced on recall (spaced repetition); identity-level facts can be pinned. **Forgetting only lowers recall weight — records and provenance are never physically deleted.**
- **Anti-fabrication**: every memory requires a verbatim quote and source; no quote, no entry. Low-confidence memories get low importance and decay away — forgetting itself is the quality filter, no manual review needed.
- **Modular & extensible**: versioned schema migrations, a pluggable Retriever interface (lexical → semantic/hybrid reserved), pure-function dynamics.
- **Zero deps**: built-in `node:sqlite` (WAL cross-process read/write), no native modules.
- **Lossless degradation**: with fact memory off or the DB absent, the other subsystems run as usual.

---

## Dev coordination mode (v1.2.2)

Makes "**main agent coordinates, clean subagents do the work**" a **tool-level-enforced** reliable workflow — not dependent on the model's self-discipline.

- **Main agent only coordinates**: split tasks, dispatch, accept results, integrate, report. Its code `edit`/`write` is blocked by a guard — **it cannot write code itself even if it wants to; it must dispatch a subagent** (model-agnostic; training differences are erased by the mechanism).
- **Three independent subagent roles, no cross-contamination**:
  - **Development**: implements code (given requirements + acceptance criteria).
  - **Test / verification**: independently runs tests and verifies against requirements; **does not trust the developer's claims**.
  - **Independent audit**: looks only at the code itself (correctness / edges / security), not at excuses.
- **Clean subagent context**: no persona injection, `recall_memory` available (verified). Independent audit catches defects the main agent's self-testing misses.
- **Safety trade-off**: `pwsh` stays with the **context-aware main agent** (it knows your machine); writing docs (`.md`) and office deliverables is unaffected.
- **Toggle**: the "dev coordination mode" switch in Settings, or slash commands `/dev` (on) / `/chat` (off) — runtime effect + persisted.

> Honest boundary: `pwsh` is deliberately kept for safety and is a known residual bypass; the `edit`/`write` main path is hard-blocked. Off by default, enable as needed.

---

## Install

**One command** — DSH fetches the repo, installs, and applies the bundle config. No manual clone, no YAML editing:

```powershell
# International (GitHub)
dsh plugin --profile desktop add https://github.com/ddt2501/dsh-doubao-memory

# China (Gitee — pick one)
dsh plugin --profile desktop add https://gitee.com/hamapiface/dsh-doubao-memory
```

> Use `--profile desktop` for DSH Desktop, `--profile web` for the CLI.

The row installs `disabled`. Enable `doubao-memory` in **Plugins**, then configure it in **Settings**:
- pick or create a persona (sets `dataRoot`) and fill in the user/assistant names;
- turn on optional subsystems (proactive outreach / per-turn snapshot / fact memory) as needed, choosing from the models already in your profile.

> Local / development: **Plugins → Add plugin** to pick a directory, or `dsh plugin --profile desktop add <absolute-path>`.

> Advanced: equivalent to adding `- id: doubao-memory / name: dsh-doubao-memory / config: …` to the profile's `cordis.patch.yml` (the bundle ships its own patch, so this is rarely needed).

## Configuration

### Core

| Key | Default | Description |
|---|---|---|
| `dataRoot` | `$DSH_HOME/personas/<assistantName>/` | Persona instance directory. **Never the package directory** (writing there is refused) |
| `stateDir` | `<dataRoot>/RUNTIME/state` | Runtime state |
| `enabled` | `true` | Plugin master switch |
| `jitrlEnabled` | `true` | JitRL master switch (memory recall + outreach modulation) |
| `factMemory.enabled` | `true` | SQLite fact-memory switch; auto-creates the DB on mount, off means SQLite is never touched |
| `persona.userName` | user | How the agent addresses the user (placeholder `{USER}`) |
| `persona.assistantName` | assistant | The agent's own name (`{ASSISTANT}`) |
| `persona.activeId` | empty | Select an existing persona directory |

### Subsystems

| Key | Default | Description |
|---|---|---|
| `proactive.*` | see [`docs/plugin-proactive.md`](docs/plugin-proactive.md) | Outreach: energy / time-slot / motive / model |
| `snapshot.*` | see [`docs/plugin-snapshot.md`](docs/plugin-snapshot.md) | Per-turn snapshot: model / timeout / fallback |
| `memory.recallCredit` | `true` | Recall credit (weighted by long-term topic importance) |
| `memory.cleanup` | `true` | Clean up old schedule tasks when phases switch to the headless service |
| `phases.*` | see [`docs/plugin-phases.md`](docs/plugin-phases.md) | Headless scheduling: dshBin / node / permissions / phase list |
| `personaEntry.enabled` | `false` | Whether to write a lean-router AGENTS.md to the workspace root. Off by default — persona goes through the system section; the plugin no longer writes a root file DSH auto-loads |
| `devMode.enabled` | `false` | Dev coordination mode: main agent only coordinates; code/test/audit go to independent subagents. Toggle in Settings or via `/dev` `/chat` |

### Placeholders

Protocol files hardcode no paths or names; they are substituted at registration: `{PKG}`=package dir, `{DATA}`=persona dir, `{USER}`=user's name, `{ASSISTANT}`=agent's name. Change machine, directory, or persona without touching the protocols.

## How it works

- **Four phases**: definitions read from `RUNTIME/manas-system/REGISTRY.json`; on cron, spawn a `dsh --profile headless` subprocess. Exit codes go to `phase-runs.json`, full output to `phase-logs/`.
- **Fact memory**: `ingest` extracts memories with quotes into SQLite (`memory-upsert.mjs`); `wiki` abstracts persona material from solidified memories (`memory-export.mjs`); `lint` runs forgetting decay (`memory-decay.mjs`).
- **Proactive outreach**: calls `ctx.llm` directly inside the plugin, no new session; decision, generation, delivery all in-plugin.
- **Snapshot**: injected via `scope.systemPrompt.section`, generated in the background, not in history; recalls by topic each turn (persona-projection, **no concrete facts** — facts go through the `recall_memory` tool).
- **JitRL**: outreach themes modulated by replies; memory recall weighted by long-term topic credit (validated internally; experiment data is not distributed with the repo).

## Layout

```
dsh-doubao-memory/
├── lib/
│   ├── index.js            root entry
│   ├── devmode.js          dev coordination mode (guard decision + coordinator SOP)
│   ├── memory/             SQLite fact memory (schema/dynamics/store/retrieval/recall/tools/export/upsert)
│   ├── phases/             four-phase headless scheduler
│   ├── proactive/          proactive outreach
│   ├── snapshot/           per-turn snapshot
│   └── jitrl/              advantage estimation / memory recall
├── RUNTIME/
│   ├── prompts/            four-phase protocols
│   ├── manas-system/       manas protocol + six questions + REGISTRY
│   └── scripts/            self-tests / memory upsert·decay·export / verification
├── templates/              empty persona skeleton
└── docs/                   design docs
```

## Docs

| Doc | Content |
|---|---|
| [`RUNTIME/manas-system/PROTOCOL.md`](RUNTIME/manas-system/PROTOCOL.md) | Manas protocol + acceptance criteria |
| [`RUNTIME/manas-system/docs/manas-six-questions.md`](RUNTIME/manas-system/docs/manas-six-questions.md) | The metaphysical structure of the six questions |
| [`RUNTIME/manas-system/docs/glossary.md`](RUNTIME/manas-system/docs/glossary.md) | Glossary + philosophical framework mapping |
| [`docs/plugin-snapshot.md`](docs/plugin-snapshot.md) | Per-turn snapshot implementation |
| [`docs/plugin-phases.md`](docs/plugin-phases.md) | Silent, auditable phase scheduling |
| [`docs/plugin-proactive.md`](docs/plugin-proactive.md) | Outreach decision & configuration |
| [`docs/PRD-JITRL.md`](docs/PRD-JITRL.md) | JitRL decision points & experimental conclusions |
| [`CHANGELOG.md`](CHANGELOG.md) | Version changes |

## Compatibility

| Item | Requirement |
|---|---|
| DSH | `>=0.2.0-rc.2 <0.3.0` |
| Node | `>=22.19.0` (built-in `node:sqlite`) |
| External deps | none (uses the models already in your profile) |

## License

MIT. Protocols and prompts ship with the package; **persona and memory do not** (they live in `dataRoot`).