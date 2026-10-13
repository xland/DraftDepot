#include "Image.h"
#include <algorithm>
#include <vector>

namespace
{
    /// 正文里图片 URL 的前缀，原生把它映射到了数据目录的 images 子目录
    const std::wstring IMAGE_URL_PREFIX = L"https://app.localhost/images/";

    /**
     * 从正文 HTML 里抽出用到的图片文件名（img_xxx.png），按出现顺序、去重。
     * 只认存在 images 子目录里的图片：外链、内联 base64 不归这张表管。
     */
    std::vector<std::wstring> extractNames(const std::wstring& contentHtml)
    {
        std::vector<std::wstring> names;
        size_t pos = 0;
        while ((pos = contentHtml.find(IMAGE_URL_PREFIX, pos)) != std::wstring::npos)
        {
            pos += IMAGE_URL_PREFIX.size();
            // src 的值到引号/尖括号/空白为止，这一截就是文件名
            auto end = contentHtml.find_first_of(L"\"'<> \t\r\n", pos);
            if (end == std::wstring::npos) end = contentHtml.size();
            auto name = contentHtml.substr(pos, end - pos);
            if (!name.empty() && std::find(names.begin(), names.end(), name) == names.end())
            {
                names.push_back(name);
            }
            pos = end;
        }
        return names;
    }
}

void Image::syncFromContent(sqlite3_int64 articleId, const std::wstring& contentHtml)
{
    sqlite3* conn = Db::get();
    if (!conn || articleId < 0) return;

    auto names = extractNames(contentHtml);
    sqlite3_exec(conn, "BEGIN;", nullptr, nullptr, nullptr);

    // 1. 先默认这篇的图片都不在了
    static const char* markSql = "UPDATE image SET is_delete = 1 WHERE article_id = ?1;";
    if (sqlite3_stmt* stmt = nullptr; sqlite3_prepare_v2(conn, markSql, -1, &stmt, nullptr) == SQLITE_OK)
    {
        sqlite3_bind_int64(stmt, 1, articleId);
        sqlite3_step(stmt);
        sqlite3_finalize(stmt);
    }

    // 2. 正文里还在的：没有就插一条，已有的（含上一步刚标成删除的）复位成 0。
    //    (article_id, img_name) 唯一，所以同一张图重复出现也只是覆盖同一条
    static const char* upsertSql =
        "INSERT INTO image (article_id, img_name, is_delete) VALUES (?1, ?2, 0)"
        " ON CONFLICT (article_id, img_name) DO UPDATE SET is_delete = 0;";
    if (sqlite3_stmt* stmt = nullptr; sqlite3_prepare_v2(conn, upsertSql, -1, &stmt, nullptr) == SQLITE_OK)
    {
        for (const auto& name : names)
        {
            sqlite3_bind_int64(stmt, 1, articleId);
            sqlite3_bind_text16(stmt, 2, name.c_str(), -1, SQLITE_TRANSIENT);
            sqlite3_step(stmt);
            sqlite3_reset(stmt);
        }
        sqlite3_finalize(stmt);
    }

    sqlite3_exec(conn, "COMMIT;", nullptr, nullptr, nullptr);
}


