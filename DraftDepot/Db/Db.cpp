#include "Db.h"
#include "Category.h"
#include "Article.h"
#include "../Env.h"
#include <chrono>
#include <cstring>
#include <filesystem>
#include <iomanip>
#include <sstream>

namespace
{
    /// 到 db.db 的持久连接：进程内只用这一个，Db::get() 直接把它交出去
    sqlite3* conn = nullptr;

    /// 数据库开不起来/建不了表就没法往下走，弹提示后直接结束进程
    [[noreturn]] void fatal(const std::wstring& detail)
    {
        auto msg = std::wstring{ L"数据库初始化失败\n\n" } + detail;
        MessageBox(nullptr, msg.c_str(), L"系统提示", MB_OK | MB_ICONERROR);
        ExitProcess(-1);
    }

    void createSchema()
    {
        static const char* schemaSql[] = {
            // ========== 文章分类（一对多的“一”端，只有一层） ==========
            // parent_id 是为兼容老库保留的废弃列，此后恒为 NULL（新库也照旧建，
            // 保证新老库 schema 一致）：老库已有这张表，DROP COLUMN / 重建表的风险
            // 远大于留一个不用的列。单层下顺序只看 sort_order（全局 0..N-1）
            "CREATE TABLE IF NOT EXISTS category ("
            "  id          INTEGER PRIMARY KEY AUTOINCREMENT,"
            "  name        TEXT    NOT NULL,"
            "  parent_id   INTEGER,"
            "  sort_order  INTEGER NOT NULL DEFAULT 0,"
            "  created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),"
            "  FOREIGN KEY (parent_id) REFERENCES category(id) ON DELETE CASCADE"
            ");",

            // ========== 文章内容（一对多的“多”端） ==========
            "CREATE TABLE IF NOT EXISTS article ("
            "  id          INTEGER PRIMARY KEY AUTOINCREMENT,"
            "  title       TEXT    NOT NULL,"
            "  content     TEXT    NOT NULL DEFAULT '',"
            "  category_id INTEGER,"
            "  created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),"
            "  updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),"
            "  FOREIGN KEY (category_id) REFERENCES category(id) ON DELETE SET NULL"
            ");",

            // ========== 文章引用的图片（一对多的“多”端） ==========
            // img_name 只存文件名（img_xxx.png）：图片都落在数据目录固定的 images 子目录下，
            // 目录层不必重复写进表里，将来拼完整路径就是 数据目录/images/文件名。
            // 图片从正文里删掉时不碰磁盘文件，只把 is_delete 置 1，将来要清理磁盘按这张表来
            "CREATE TABLE IF NOT EXISTS image ("
            "  id          INTEGER PRIMARY KEY AUTOINCREMENT,"
            "  article_id  INTEGER NOT NULL,"
            "  img_name    TEXT    NOT NULL,"
            "  is_delete   INTEGER NOT NULL DEFAULT 0,"
            "  UNIQUE (article_id, img_name),"
            "  FOREIGN KEY (article_id) REFERENCES article(id) ON DELETE CASCADE"
            ");",

            // ========== 站点配置（某个网站专用的参数，按"站点名 + 参数键"取值） ==========
            // 例如微信后台的登录凭证：name = "WeiXin"，param_key = "token"，param_val = "996767730"
            // (name, param_key) 唯一：同一个站点的同一个参数只留一条，配合 UPSERT 覆盖写
            "CREATE TABLE IF NOT EXISTS site ("
            "  id         INTEGER PRIMARY KEY AUTOINCREMENT,"
            "  name       TEXT    NOT NULL,"
            "  param_key  TEXT    NOT NULL,"
            "  param_val  TEXT,"
            "  UNIQUE (name, param_key)"
            ");",

            // ========== 图片在对方图床上的地址（按"图片文件 + 站点"记一条） ==========
            // 正文里的图存在本地 images 目录，发布时才由站点脚本传对方图床；传出来的地址记在这里，
            // 下次发布前先查：重发这一篇、或别的文章用到同一张图，都不必再传一遍，
            // 对方图床也不会堆重复副本（取地址那一头见 JS/Msg.js 的 imageUrl）。
            // (image_name, site_name) 唯一：一张图在一个站点只留一条，重复传就覆盖成新地址；
            // 唯一约束顺带把索引也建了，查询正是按这两列，不必再单独建一个。
            // 文件名（img_xxx.png）是存图时一次性生成、之后从不改写的，
            // 所以"同名"必然是同一份内容，拿它当缓存键不会误命中
            "CREATE TABLE IF NOT EXISTS image_site ("
            "  id         INTEGER PRIMARY KEY AUTOINCREMENT,"
            "  image_name TEXT    NOT NULL,"
            "  site_name  TEXT    NOT NULL,"
            "  url        TEXT    NOT NULL,"
            "  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),"
            "  UNIQUE (image_name, site_name)"
            ");",

            // ========== 索引 ==========
            "CREATE INDEX IF NOT EXISTS idx_category_parent ON category(parent_id);",
            "CREATE INDEX IF NOT EXISTS idx_article_category ON article(category_id);",
            "CREATE INDEX IF NOT EXISTS idx_article_created ON article(created_at);",
            "CREATE INDEX IF NOT EXISTS idx_image_article ON image(article_id);",
            "CREATE INDEX IF NOT EXISTS idx_site_name ON site(name);",
        };

        for (const char* sql : schemaSql)
        {
            char* errMsg = nullptr;
            if (sqlite3_exec(conn, sql, nullptr, nullptr, &errMsg) != SQLITE_OK)
            {
                sqlite3_free(errMsg);
                fatal(L"建表失败\n\n"
                    + std::wstring{ static_cast<const wchar_t*>(sqlite3_errmsg16(conn)) });
            }
        }
    }

    /// 外键约束默认是关闭的：不显式打开，建表时写的 ON DELETE CASCADE / SET NULL 全是摆设。
    /// 这个开关不是写进库文件的持久属性，每条连接都必须设一次，且要设在事务之外。
    /// 打开之后由 SQLite 兜住：删文章时它在 image 表里的记录被连带删掉，不用调用方自己记着收拾。
    /// （category 的 parent_id 自引用外键还在，但单层结构下它恒为 NULL，不再有连带删除）
    void enableForeignKeys()
    {
        if (sqlite3_exec(conn, "PRAGMA foreign_keys = ON;", nullptr, nullptr, nullptr) != SQLITE_OK)
            fatal(L"启用外键约束失败\n\n"
                + std::wstring{ static_cast<const wchar_t*>(sqlite3_errmsg16(conn)) });

        // PRAGMA 执行成功不等于真的开了：编译期去掉外键支持时它是静默无效的，读回来确认一下
        sqlite3_stmt* stmt = nullptr;
        bool on = false;
        if (sqlite3_prepare_v2(conn, "PRAGMA foreign_keys;", -1, &stmt, nullptr) == SQLITE_OK)
        {
            if (sqlite3_step(stmt) == SQLITE_ROW) on = sqlite3_column_int(stmt, 0) != 0;
            sqlite3_finalize(stmt);
        }
        if (!on) fatal(L"SQLite 未启用外键支持\n\n这一版 sqlite3 可能是在关闭外键的情况下编译的");
    }

    /// 数据升级出问题时只提示、不结束进程：迁移失败会回滚，老库原封不动，
    /// 而新代码读分类是全表平铺、并不依赖 parent_id，程序照常能用
    void warn(const std::wstring& detail)
    {
        auto msg = std::wstring{ L"文章目录升级提示\n\n" } + detail;
        MessageBox(nullptr, msg.c_str(), L"系统提示", MB_OK | MB_ICONWARNING);
    }

    /// user_version：0 = 老版本（可能有多级分类），1 = 已经是单层结构。
    /// 这是 SQLite 写在库文件头里的持久标记，比自建 meta 表省事，也不会被 createSchema 重建
    int userVersion()
    {
        sqlite3_stmt* stmt = nullptr;
        int version = 0;
        if (sqlite3_prepare_v2(conn, "PRAGMA user_version;", -1, &stmt, nullptr) == SQLITE_OK)
        {
            if (sqlite3_step(stmt) == SQLITE_ROW) version = sqlite3_column_int(stmt, 0);
            sqlite3_finalize(stmt);
        }
        return version;
    }

    /**
     * 一次性迁移：把老库里可能存在的多级分类压平成单层。
     * 详细理由与逐条 SQL 见 Db/migrate_flat_categories.sql（两处语句必须保持一致）。
     *
     * 保全数据的关键：只 UPDATE category 自己这几列，不删任何分类行、不动 article 一行、
     * 不重编 id、不重建表。于是文章原先归在哪个分类就还在哪个分类，
     * 外键 ON DELETE CASCADE / SET NULL 连触发的机会都没有。
     */
    void migrateToFlatCategories()
    {
        constexpr int FLAT_SCHEMA_VERSION = 1;
        if (userVersion() >= FLAT_SCHEMA_VERSION) return;

        // 分类表是空的（新库，或用户本来就删光了分类）：没有层级可压，打上标记即可，也不必备份
        sqlite3_stmt* stmt = nullptr;
        sqlite3_int64 count = 0;
        if (sqlite3_prepare_v2(conn, "SELECT COUNT(*) FROM category;", -1, &stmt, nullptr) != SQLITE_OK)
        {
            warn(L"没能确认现有分类数量，已跳过本次升级；原数据未改动。");
            return;
        }
        if (sqlite3_step(stmt) == SQLITE_ROW) count = sqlite3_column_int64(stmt, 0);
        sqlite3_finalize(stmt);
        if (count == 0)
        {
            sqlite3_exec(conn, "PRAGMA user_version = 1;", nullptr, nullptr, nullptr);
            return;
        }

        // 整库备份：出任何问题都能把这一个文件复制回去，不必依赖事务日志
        auto dbPath = Env::getDataPath() / L"db.db";
        auto now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
        std::tm local{};
        localtime_s(&local, &now);
        std::wostringstream stamp;
        stamp << std::put_time(&local, L"%Y%m%d-%H%M%S");
        auto backup = dbPath;
        backup += L".bak-" + stamp.str();
        std::error_code ec;
        std::filesystem::copy_file(dbPath, backup, std::filesystem::copy_options::none, ec);
        if (ec)
        {
            // 备份不了就不冒险改数据：留着多级结构，新代码照样能把它们当成一层显示
            warn(L"升级前备份数据库失败，为安全起见本次不改动数据。\n\n"
                + backup.wstring() + L"\n\nerror_code = " + std::to_wstring(ec.value()));
            return;
        }

        // 与 Db/migrate_flat_categories.sql 完全一致的语句，改一处要同步改另一处。
        // 放在 enableForeignKeys() 之前跑：这组 UPDATE 不触发外键，且省去事务内外开关 PRAGMA 的麻烦
        static const char* migrationSql[] = {
            "BEGIN IMMEDIATE;",
            // 先按旧版 load() 的树展开顺序全局重排；CASE 保证重复执行时按当前 sort_order 原样写回
            "WITH ordered AS ("
            " SELECT id, ROW_NUMBER() OVER ("
            "  ORDER BY CASE WHEN (SELECT COUNT(*) FROM category WHERE parent_id IS NOT NULL) > 0"
            "   THEN COALESCE(parent_id, id) ELSE 0 END, sort_order, id) - 1 AS n"
            " FROM category)"
            "UPDATE category SET sort_order = (SELECT n FROM ordered WHERE ordered.id = category.id);",
            "UPDATE category SET parent_id = NULL WHERE parent_id IS NOT NULL;",
            // 不同父下的同名分类平铺后会分不清：同名里 id 最小的留原名，其余加 " (id)"
            "WITH ranked AS ("
            " SELECT id, ROW_NUMBER() OVER (PARTITION BY name ORDER BY id) AS rn FROM category)"
            "UPDATE category SET name = name || ' (' || id || ')'"
            " WHERE id IN (SELECT id FROM ranked WHERE rn > 1);",
            "PRAGMA user_version = 1;",
            "COMMIT;",
        };

        for (const char* sql : migrationSql)
        {
            if (sqlite3_exec(conn, sql, nullptr, nullptr, nullptr) == SQLITE_OK) continue;
            auto detail = std::wstring{ static_cast<const wchar_t*>(sqlite3_errmsg16(conn)) };
            sqlite3_exec(conn, "ROLLBACK;", nullptr, nullptr, nullptr);
            warn(L"文章目录升级失败，已回滚，原数据未改动。\n\n备份：\n" + backup.wstring()
                + L"\n\n" + detail);
            return;
        }
    }

    void open()
    {
        // 数据目录由 Env::initDataPath 负责创建；db.db 不存在时 sqlite3 会自动创建文件
        auto dbPath = Env::getDataPath() / L"db.db";
        // sqlite3 按 UTF-8 解析路径，这里显式转 UTF-8：既避免 path::string() 的 ANSI 转换
        // 在中文用户名下打不开库，也不用 sqlite3_open16 —— 后者会顺手执行
        // PRAGMA encoding='UTF-16'，把新库的默认编码从 UTF-8 改成 UTF-16le
        auto u8Path = dbPath.u8string();
        auto rc = sqlite3_open(reinterpret_cast<const char*>(u8Path.c_str()), &conn);
        if (rc != SQLITE_OK)
        {
            auto detail = L"无法打开数据库文件\n\n" + dbPath.wstring() + L"\n\n"
                + (conn ? std::wstring{ static_cast<const wchar_t*>(sqlite3_errmsg16(conn)) }
                        : std::wstring{ L"无法创建数据库连接" });
            sqlite3_close(conn);
            fatal(detail);
        }

        createSchema();
        // 老库的多级分类在这里压平（新库只打版本标记）；必须在 enableForeignKeys() 之前，
        // 保证 PRAGMA 都处在事务之外
        migrateToFlatCategories();
        enableForeignKeys();
    }
}

void Db::init()
{
    open();
    Category::seed();
}

sqlite3* Db::get()
{
    return conn;
}
