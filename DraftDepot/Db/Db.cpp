#include "Db.h"
#include "Category.h"
#include "Article.h"
#include "../Env.h"
#include <cstring>

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
            // ========== 文章分类（一对多的“一”端，支持多级树形） ==========
            // parent_id 为 NULL 表示顶层分类；同层用 sort_order 排序
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
    /// 打开之后两件事由 SQLite 兜住：删分类时它的子孙被 CASCADE 连带删掉；
    /// 删文章时它在 image 表里的记录被连带删掉，不用调用方自己记着收拾。
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
