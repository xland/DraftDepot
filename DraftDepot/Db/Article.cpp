#include "Article.h"
#include "Image.h"

JsonArray Article::loadTitles(sqlite3_int64 categoryId)
{
    JsonArray arr;
    sqlite3* conn = Db::get();
    if (!conn) return arr;

    // 只取标题（外加 id、分类 id 和更新时间），不查 content
    // 按修改时间倒序：刚更新的排在列表最上面。同一秒里写过的多篇（updated_at 只到秒）
    // 用 id 倒序兜住，保证后来的一定更靠前
    static const char* sqlAll =
        "SELECT id, title, category_id, updated_at FROM article ORDER BY updated_at DESC, id DESC;";
    // 按分类过滤：单层结构，等值查这个分类名下的文章即可（不再需要递归 CTE）
    static const char* sqlByCategory =
        "SELECT id, title, category_id, updated_at FROM article"
        " WHERE category_id = ?1"
        " ORDER BY updated_at DESC, id DESC;";

    sqlite3_stmt* stmt = nullptr;
    if (categoryId < 0)
    {
        if (sqlite3_prepare_v2(conn, sqlAll, -1, &stmt, nullptr) != SQLITE_OK)
            return arr;
    }
    else
    {
        if (sqlite3_prepare_v2(conn, sqlByCategory, -1, &stmt, nullptr) != SQLITE_OK)
            return arr;
        sqlite3_bind_int64(stmt, 1, categoryId);
    }

    while (sqlite3_step(stmt) == SQLITE_ROW)
    {
        JsonObject node;
        node.SetNamedValue(L"id", JsonValue::CreateNumberValue(static_cast<double>(sqlite3_column_int64(stmt, 0))));
        node.SetNamedValue(L"title", JsonValue::CreateStringValue(
            std::wstring(static_cast<const wchar_t*>(sqlite3_column_text16(stmt, 1)))));

        if (sqlite3_column_type(stmt, 2) == SQLITE_NULL)
            node.SetNamedValue(L"categoryId", JsonValue::CreateNullValue());
        else
            node.SetNamedValue(L"categoryId", JsonValue::CreateNumberValue(static_cast<double>(sqlite3_column_int64(stmt, 2))));

        // updated_at 是 datetime('now','localtime') 写下的 "YYYY-MM-DD HH:MM:SS"
        node.SetNamedValue(L"updatedAt", JsonValue::CreateStringValue(
            std::wstring(static_cast<const wchar_t*>(sqlite3_column_text16(stmt, 3)))));

        arr.Append(static_cast<winrt::Windows::Data::Json::IJsonValue>(node));
    }
    sqlite3_finalize(stmt);
    return arr;
}

JsonObject Article::loadArticle(sqlite3_int64 id)
{
    JsonObject obj;
    sqlite3* conn = Db::get();
    if (!conn) return obj;

    static const char* sql =
        "SELECT title, content, category_id, updated_at FROM article WHERE id = ?1;";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(conn, sql, -1, &stmt, nullptr) != SQLITE_OK) return obj;
    sqlite3_bind_int64(stmt, 1, id);

    if (sqlite3_step(stmt) == SQLITE_ROW)
    {
        obj.SetNamedValue(L"id", JsonValue::CreateNumberValue(static_cast<double>(id)));
        obj.SetNamedValue(L"title", JsonValue::CreateStringValue(
            std::wstring(static_cast<const wchar_t*>(sqlite3_column_text16(stmt, 0)))));
        obj.SetNamedValue(L"content", JsonValue::CreateStringValue(
            std::wstring(static_cast<const wchar_t*>(sqlite3_column_text16(stmt, 1)))));

        if (sqlite3_column_type(stmt, 2) == SQLITE_NULL)
            obj.SetNamedValue(L"categoryId", JsonValue::CreateNullValue());
        else
            obj.SetNamedValue(L"categoryId", JsonValue::CreateNumberValue(static_cast<double>(sqlite3_column_int64(stmt, 2))));

        obj.SetNamedValue(L"updatedAt", JsonValue::CreateStringValue(
            std::wstring(static_cast<const wchar_t*>(sqlite3_column_text16(stmt, 3)))));
    }
    sqlite3_finalize(stmt);
    return obj;
}

sqlite3_int64 Article::addArticle(const std::wstring& title, const std::wstring& content, sqlite3_int64 categoryId)
{
    sqlite3* conn = Db::get();
    if (!conn) return -1;

    static const char* sql =
        "INSERT INTO article (title, content, category_id, updated_at)"
        " VALUES (?1, ?2, ?3, datetime('now', 'localtime'));";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(conn, sql, -1, &stmt, nullptr) != SQLITE_OK) return -1;

    sqlite3_bind_text16(stmt, 1, title.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text16(stmt, 2, content.c_str(), -1, SQLITE_TRANSIENT);
    // 未分类（categoryId < 0）写 NULL：article.category_id 允许为空，列表读到的是 null 而不是 0
    if (categoryId < 0) sqlite3_bind_null(stmt, 3);
    else sqlite3_bind_int64(stmt, 3, categoryId);

    sqlite3_int64 id = -1;
    if (sqlite3_step(stmt) == SQLITE_DONE) id = sqlite3_last_insert_rowid(conn);
    sqlite3_finalize(stmt);
    // 正文里带的图片（比如从别处整段粘进来的）一并记进 image 表
    if (id > 0) Image::syncFromContent(id, content);
    return id;
}

bool Article::updateArticle(sqlite3_int64 id, const std::wstring& title, const std::wstring& content)
{
    sqlite3* conn = Db::get();
    if (!conn) return false;

    static const char* sql =
        "UPDATE article SET title = ?2, content = ?3,"
        " updated_at = datetime('now', 'localtime') WHERE id = ?1;";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(conn, sql, -1, &stmt, nullptr) != SQLITE_OK) return false;

    sqlite3_bind_int64(stmt, 1, id);
    sqlite3_bind_text16(stmt, 2, title.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text16(stmt, 3, content.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    bool ok = sqlite3_changes(conn) > 0;
    // 正文入库后再同步图片记录：正文里删掉的图标成 is_delete = 1，撤回来的复位成 0，磁盘文件不动
    if (ok) Image::syncFromContent(id, content);
    return ok;
}

bool Article::removeArticle(sqlite3_int64 id)
{
    sqlite3* conn = Db::get();
    if (!conn) return false;

    static const char* sql = "DELETE FROM article WHERE id = ?1;";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(conn, sql, -1, &stmt, nullptr) != SQLITE_OK) return false;
    sqlite3_bind_int64(stmt, 1, id);
    // sqlite3_changes 用来区分"删到了"和"本来就没有这篇"
    bool ok = (sqlite3_step(stmt) == SQLITE_DONE) && (sqlite3_changes(conn) > 0);
    sqlite3_finalize(stmt);
    return ok;
}

sqlite3_int64 Article::count()
{
    sqlite3* conn = Db::get();
    if (!conn) return 0;

    // 状态栏要的总数：不论分类、不论有没有正文，库里有多少篇就是多少
    static const char* sql = "SELECT COUNT(*) FROM article;";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(conn, sql, -1, &stmt, nullptr) != SQLITE_OK) return 0;
    sqlite3_int64 n = 0;
    if (sqlite3_step(stmt) == SQLITE_ROW) n = sqlite3_column_int64(stmt, 0);
    sqlite3_finalize(stmt);
    return n;
}

