/**
 * 记忆库 Schema 与版本化迁移 —— 存储结构的唯一真相源。
 *
 * ## 分层（v2，token 效率 + 模块化）
 *   - **memory_gist**（轻）：三元组 + 强度/温度字段。排序、召回、老化只用它（窄表）。
 *   - **memory_detail**（重）：原话 quote + 出处 source_ref + 元数据。按 id 才取。
 *   - **memory**（视图）：gist ⋈ detail，向后兼容旧的 `SELECT * FROM memory`。
 *   - **memory_fts**：FTS5 trigram，content=memory_gist，触发器挂在 gist 上。
 *
 * 召回默认只回 gist（~10-20 tok/条），出处只在 memory_get 核对时取 —— 这是 token 效率的根。
 *
 * ## 扩展余地（留足冗余接口）
 *   - 迁移按 user_version 顺序执行；未来加列/加表（如 memory_vector 语义向量、
 *     memory_edge 图关系）只需追加一个 migration 步骤，不破坏既有数据。
 *   - gist/detail 的列划分稳定；新增"召回可见"字段进 gist，"仅核对"字段进 detail。
 *
 * ## 版本
 *   v1：单 memory 表（历史）。
 *   v2：gist/detail 物理分层 + memory 视图。
 */

export const SCHEMA_VERSION = 2

/** gist 列（召回/排序/老化/有效性所需） */
const GIST_COLS = `
  id            INTEGER PRIMARY KEY,
  subject       TEXT NOT NULL,
  predicate     TEXT NOT NULL,
  object        TEXT NOT NULL,
  type          TEXT NOT NULL,
  importance    REAL DEFAULT 0.5,
  stability     REAL NOT NULL,
  recall_count  INTEGER DEFAULT 0,
  last_recalled TEXT,
  pinned        INTEGER DEFAULT 0,
  status        TEXT DEFAULT 'active',
  forget_stage  INTEGER DEFAULT 0,
  forget_since  TEXT,
  valid_to      TEXT,
  created_at    TEXT NOT NULL
`

/** detail 列（出处/原话/元数据，按 id 才取） */
const DETAIL_COLS = `
  id            INTEGER PRIMARY KEY,
  quote         TEXT NOT NULL,
  source_ref    TEXT NOT NULL,
  confidence    REAL DEFAULT 0.8,
  valid_from    TEXT NOT NULL,
  superseded_by INTEGER
`

/** memory 视图：gist ⋈ detail（列集合与 v1 单表一致，兼容旧读取） */
const MEMORY_VIEW = `
  CREATE VIEW IF NOT EXISTS memory AS
  SELECT g.id, g.subject, g.predicate, g.object, g.type,
         d.source_ref, d.quote, d.confidence, d.valid_from,
         g.valid_to, d.superseded_by,
         g.importance, g.stability, g.recall_count, g.last_recalled,
         g.pinned, g.forget_stage, g.forget_since, g.status, g.created_at
  FROM memory_gist g JOIN memory_detail d ON g.id = d.id
`

/** FTS5（trigram）+ gist 同步触发器 + 索引 */
const FTS_AND_INDEXES = `
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    subject, predicate, object,
    content='memory_gist', content_rowid='id', tokenize='trigram'
  );
  CREATE TRIGGER IF NOT EXISTS gist_ai AFTER INSERT ON memory_gist BEGIN
    INSERT INTO memory_fts(rowid, subject, predicate, object)
    VALUES (new.id, new.subject, new.predicate, new.object);
  END;
  CREATE TRIGGER IF NOT EXISTS gist_ad AFTER DELETE ON memory_gist BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, subject, predicate, object)
    VALUES ('delete', old.id, old.subject, old.predicate, old.object);
  END;
  CREATE TRIGGER IF NOT EXISTS gist_au AFTER UPDATE ON memory_gist BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, subject, predicate, object)
    VALUES ('delete', old.id, old.subject, old.predicate, old.object);
    INSERT INTO memory_fts(rowid, subject, predicate, object)
    VALUES (new.id, new.subject, new.predicate, new.object);
  END;
  CREATE INDEX IF NOT EXISTS idx_gist_sp ON memory_gist(subject, predicate);
  CREATE INDEX IF NOT EXISTS idx_gist_status ON memory_gist(status, forget_stage);
`

/** 全新库：直接建 v2 结构 */
function createV2Fresh(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_gist (${GIST_COLS});`)
  db.exec(`CREATE TABLE IF NOT EXISTS memory_detail (${DETAIL_COLS});`)
  db.exec(MEMORY_VIEW)
  db.exec(FTS_AND_INDEXES)
}

/** v1 → v2：拆单表为 gist/detail，保留全部数据，memory 降为视图 */
function migrateV1toV2(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_gist (${GIST_COLS});`)
  db.exec(`CREATE TABLE IF NOT EXISTS memory_detail (${DETAIL_COLS});`)
  db.exec(`
    INSERT INTO memory_gist
      (id, subject, predicate, object, type, importance, stability, recall_count,
       last_recalled, pinned, status, forget_stage, forget_since, valid_to, created_at)
    SELECT id, subject, predicate, object, type, importance, stability, recall_count,
       last_recalled, pinned, status, forget_stage, forget_since, valid_to, created_at
    FROM memory;
  `)
  db.exec(`
    INSERT INTO memory_detail
      (id, quote, source_ref, confidence, valid_from, superseded_by)
    SELECT id, quote, source_ref, confidence, valid_from, superseded_by
    FROM memory;
  `)
  // 拆完再拆旧结构（视图要占用 memory 这个名字，必须先 drop 旧表）
  db.exec(`
    DROP TRIGGER IF EXISTS memory_ai;
    DROP TRIGGER IF EXISTS memory_ad;
    DROP TRIGGER IF EXISTS memory_au;
    DROP TABLE IF EXISTS memory_fts;
    DROP TABLE IF EXISTS memory;
  `)
  db.exec(MEMORY_VIEW)
  db.exec(FTS_AND_INDEXES)
}

/**
 * 幂等迁移：按 user_version 分派。
 *   0（全新）→ 建 v2；1 → 迁 v2；≥2 → 无操作。
 * 未来版本在此追加 `if (ver < N) { ...migrate... }` 步骤即可。
 */
export function migrate(db) {
  const ver = db.prepare('PRAGMA user_version').get().user_version
  if (ver >= SCHEMA_VERSION) return
  if (ver === 0) {
    createV2Fresh(db)
  } else if (ver === 1) {
    migrateV1toV2(db)
  } else {
    throw new Error(`memory schema: 未知版本 ${ver}，无法迁移到 ${SCHEMA_VERSION}`)
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}