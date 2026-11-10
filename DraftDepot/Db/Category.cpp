#include "Category.h"

namespace
{
    /// 跑一条带一个 id 参数的 COUNT(*) 语句：查出来是计数，查不出来（prepare/step 失败）返回 -1。
    /// 不把失败当成 0：0 会让调用方把"没查清"当成"没有"，从而放行一次不可撤销的删除
    int countById(sqlite3* conn, const char* sql, sqlite3_int64 id)
    {
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(conn, sql, -1, &stmt, nullptr) != SQLITE_OK) return -1;
        sqlite3_bind_int64(stmt, 1, id);
        int count = -1;
        if (sqlite3_step(stmt) == SQLITE_ROW) count = sqlite3_column_int(stmt, 0);
        sqlite3_finalize(stmt);
        return count;
    }
}

JsonArray Category::load()
{
    JsonArray arr;
    sqlite3* conn = Db::get();
    if (!conn) return arr;

    // 单层：全表按 sort_order 平铺读出，不再读 parent_id（老库里那一列恒为 NULL）
    const char* sql = "SELECT id, name FROM category ORDER BY sort_order, id;";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(conn, sql, -1, &stmt, nullptr) != SQLITE_OK)
        return arr;

    while (sqlite3_step(stmt) == SQLITE_ROW)
    {
        JsonObject node;
        node.SetNamedValue(L"id", JsonValue::CreateNumberValue(static_cast<double>(sqlite3_column_int64(stmt, 0))));
        // sqlite3_column_text16 以 UTF-16 返回，可直接构造成 wstring，避免手工转码
        node.SetNamedValue(L"name", JsonValue::CreateStringValue(
            std::wstring(static_cast<const wchar_t*>(sqlite3_column_text16(stmt, 1)))));
        // parentId 仍留在回包里、恒为 null：前端/站点脚本即使还认这个字段也不会出错，
        // 但不会再有人靠它组树（见 UI/src/Category/Category.ts）
        node.SetNamedValue(L"parentId", JsonValue::CreateNullValue());

        // 显式转成 IJsonValue 后再追加，避免 JsonObject→IJsonValue 隐式转换
        // 在 Append 模板体内触发的 C3779（返回 auto 的函数须先定义）
        arr.Append(static_cast<winrt::Windows::Data::Json::IJsonValue>(node));
    }
    sqlite3_finalize(stmt);
    return arr;
}

sqlite3_int64 Category::add(const std::wstring& name, sqlite3_int64 /*parentId*/)
{
    sqlite3* conn = Db::get();
    if (!conn || name.empty()) return -1;

    // 单层：一律建顶层（parent_id 不写，默认 NULL），sort_order 取全表最大值 +1 排在末尾。
    // parentId 参数留在签名里只是为了兼容旧前端仍可能带来的 IPC 参数，这里刻意忽略——
    // 不再允许建子分类
    static const char* sql =
        "INSERT INTO category (name, sort_order)"
        " VALUES (?1, COALESCE((SELECT MAX(sort_order) + 1 FROM category), 0));";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(conn, sql, -1, &stmt, nullptr) != SQLITE_OK) return -1;
    sqlite3_bind_text16(stmt, 1, name.c_str(), -1, SQLITE_TRANSIENT);
    bool ok = (sqlite3_step(stmt) == SQLITE_DONE);
    sqlite3_finalize(stmt);
    return ok ? sqlite3_last_insert_rowid(conn) : -1;
}

bool Category::rename(sqlite3_int64 id, const std::wstring& name)
{
    sqlite3* conn = Db::get();
    if (!conn || id < 0 || name.empty()) return false;

    static const char* sql = "UPDATE category SET name = ?2 WHERE id = ?1;";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(conn, sql, -1, &stmt, nullptr) != SQLITE_OK) return false;
    sqlite3_bind_int64(stmt, 1, id);
    sqlite3_bind_text16(stmt, 2, name.c_str(), -1, SQLITE_TRANSIENT);
    // sqlite3_changes 用来区分"改到了"和"id 不存在"
    bool ok = (sqlite3_step(stmt) == SQLITE_DONE) && (sqlite3_changes(conn) > 0);
    sqlite3_finalize(stmt);
    return ok;
}

bool Category::remove(sqlite3_int64 id, std::wstring& reason)
{
    sqlite3* conn = Db::get();
    if (!conn || id < 0) return false;

    // 只删"空分类"：下面挂着文章的一律挡回来，原因写进 reason 由 UI 弹给用户。
    // 宁可多挡一道——删分类不可撤销，而"文章散成未分类"这种后果是用户看不见的。
    // 单层后没有子树的概念，等值查自己名下的文章即可（不再需要递归 CTE）
    static const char* articleSql = "SELECT COUNT(*) FROM article WHERE category_id = ?1;";
    int articles = countById(conn, articleSql, id);
    if (articles != 0)
    {
        reason = articles > 0
            ? std::wstring{ L"该分类下还有 " } + std::to_wstring(articles) + L" 篇文章，先移走再删"
            : std::wstring{ L"没能确认这个分类下的文章，先不删" };
        return false;
    }

    // 走到这里：这个分类没有文章，删它自己一行就够了
    static const char* delSql = "DELETE FROM category WHERE id = ?1;";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(conn, delSql, -1, &stmt, nullptr) != SQLITE_OK) return false;
    sqlite3_bind_int64(stmt, 1, id);
    // sqlite3_changes 用来区分"删到了"和"id 根本不存在"（与 rename 同一套写法）
    bool ok = (sqlite3_step(stmt) == SQLITE_DONE) && (sqlite3_changes(conn) > 0);
    sqlite3_finalize(stmt);
    if (!ok && reason.empty()) reason = L"这个分类已经不存在了";
    return ok;
}

sqlite3_int64 Category::count()
{
    sqlite3* conn = Db::get();
    if (!conn) return 0;

    // 状态栏要的总数：不分层级、不看选中，库里有多少个就是多少个
    static const char* sql = "SELECT COUNT(*) FROM category;";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(conn, sql, -1, &stmt, nullptr) != SQLITE_OK) return 0;
    sqlite3_int64 n = 0;
    if (sqlite3_step(stmt) == SQLITE_ROW) n = sqlite3_column_int64(stmt, 0);
    sqlite3_finalize(stmt);
    return n;
}

void Category::seed()
{
    sqlite3* conn = Db::get();
    if (!conn) return;

    // 仅在分类表为空时写入初始分类，避免每次启动都重插一遍
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(conn, "SELECT COUNT(*) FROM category;", -1, &stmt, nullptr) != SQLITE_OK)
        return;
    sqlite3_step(stmt);
    bool empty = (sqlite3_column_int(stmt, 0) == 0);
    sqlite3_finalize(stmt);
    if (!empty) return;

    auto insertOne = [&](const std::wstring& name, int order) -> sqlite3_int64
    {
        // 单层：不写 parent_id（默认 NULL），sort_order 全局递增
        static const char* insertSql =
            "INSERT INTO category (name, sort_order) VALUES (?1, ?2);";
        sqlite3_stmt* ins = nullptr;
        if (sqlite3_prepare_v2(conn, insertSql, -1, &ins, nullptr) != SQLITE_OK) return -1;
        sqlite3_bind_text16(ins, 1, name.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int(ins, 2, order);
        sqlite3_step(ins);
        sqlite3_finalize(ins);
        return sqlite3_last_insert_rowid(conn);
    };

    // 三个初始分类一律顶层；原来「开发 → C++」那种嵌套样例不能再写，否则新库又是多级
    insertOne(L"架构", 0);
    insertOne(L"开发", 1);
    insertOne(L"C++", 2);
}
