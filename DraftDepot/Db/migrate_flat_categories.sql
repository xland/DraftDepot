-- ============================================================================
-- 把多级文章分类压平成单层（一次性迁移）
--
-- 这是 Db.cpp 里 migrateToFlatCategories() 所执行 SQL 的可读镜像：两处语句必须一致，
-- 改这里就要同步改 Db.cpp。程序启动时会自动执行（带备份、事务、user_version 幂等标记），
-- 正常情况下不需要手工跑这个文件；它留作人工核对 / 离线修复 / 审计用。
--
-- 数据保全的做法（关键）：
--   只把 category.parent_id 置 NULL，把每个子分类"提升"为顶层。
--   * 不删任何 category 行 —— 分类一个不少，id 也不重编（前端 / IPC 全靠 id 认分类）；
--   * 不动 article 一行 —— 文章的 category_id 原样保留，归档信息一点不丢；
--   * 不重建表 —— 外键 parent_id ... ON DELETE CASCADE / article.category_id ... ON DELETE SET NULL
--     都没有触发机会，不会出现"删父分类带走整棵子树、文章悄悄变成未分类"。
--
-- parent_id 列本身保留（此后恒为 NULL）：老库已经建好了这张表，ALTER / DROP 要重建表，
-- 风险远大于留一个不再使用的列；新库也照旧建这一列，保证新老库 schema 一致。
--
-- 手工执行前请先备份 db.db（程序自动迁移时会自己备份）：
--   sqlite3 db.db < migrate_flat_categories.sql
-- 回滚：直接把备份文件复制回 db.db。
-- ============================================================================

BEGIN IMMEDIATE;

-- 1. 先按"原来树的展开顺序"（与旧版 Category::load 的 ORDER BY 一致）全局重排 sort_order。
--    必须在压平之前算：下一步把 parent_id 清空之后，COALESCE(parent_id, id) 就失去意义了。
--    CASE 是幂等保护：库里已经没有子分类（说明迁移跑过了、或被人手工又跑了一次）时，
--    改成只按当前 sort_order 排，序号原样写回，不会把已经排好的顺序洗掉。
WITH ordered AS (
  SELECT id,
         ROW_NUMBER() OVER (
           ORDER BY CASE WHEN (SELECT COUNT(*) FROM category WHERE parent_id IS NOT NULL) > 0
                         THEN COALESCE(parent_id, id) ELSE 0 END,
                    sort_order, id) - 1 AS n
    FROM category
)
UPDATE category
   SET sort_order = (SELECT n FROM ordered WHERE ordered.id = category.id);

-- 2. 压平：所有分类都成为顶层。只改这一列，不删行。
UPDATE category SET parent_id = NULL WHERE parent_id IS NOT NULL;

-- 3. 消歧：多层时不同父下可以有同名分类，平铺后就分不清了。
--    同名里 id 最小的保持原名，其余追加 " (id)"：带上次序又能对上原 id，且不会循环冲突。
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY name ORDER BY id) AS rn FROM category
)
UPDATE category
   SET name = name || ' (' || id || ')'
 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 4. 幂等标记：>= 1 表示已经是单层结构，下次启动不再迁移。
PRAGMA user_version = 1;

COMMIT;
