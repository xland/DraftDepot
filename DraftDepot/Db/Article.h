#pragma once
#include "Db.h"
#include <string>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.Collections.h> // 提供 IVector::Append 的定义，避免 C3779

using namespace winrt::Windows::Data::Json;

/**
 * 文章的数据访问：标题列表的读取（不查正文）。
 * 与 Category 平级，直接对外提供服务；数据库连接统一从 Db::get() 取，本类不持有连接。
 */
class Article
{
public:
	/// 读取文章标题（不查正文），按修改时间倒序（同一秒写的多篇再按 id 倒序）：最近改过的在最上面，
	/// 新建一篇后不需要重新查就能知道它排第一（它的 updated_at 就是当时）
	/// 每项：{ "id": <int>, "title": <string>, "categoryId": <int|null>, "updatedAt": "YYYY-MM-DD HH:MM:SS" }
	/// categoryId < 0 表示不过滤；否则只取该分类名下的文章（单层目录，不存在子分类）
	static JsonArray loadTitles(sqlite3_int64 categoryId);
	/// 读取单篇文章（含正文）；id 不存在时返回空 JsonObject（调用方按 HasKey(L"id") 判断）
	/// 返回：{ "id": <int>, "title": <string>, "content": <string>, "categoryId": <int|null>, "updatedAt": <string> }
	static JsonObject loadArticle(sqlite3_int64 id);
	/// 新建文章：categoryId < 0 表示未分类；返回新文章的 id，写入失败返回 -1
	static sqlite3_int64 addArticle(const std::wstring& title, const std::wstring& content, sqlite3_int64 categoryId);
	/// 更新已有文章的标题与正文，同时把 updated_at 刷成当前时间；返回是否真的改到了一行。
	/// 正文写进去之后顺带按正文同步 image 表的记录（见 Image::syncFromContent）
	static bool updateArticle(sqlite3_int64 id, const std::wstring& title, const std::wstring& content);
	/// 删除一篇文章；确实删到了一行才返回 true（id 不存在返回 false）
	static bool removeArticle(sqlite3_int64 id);
	/// 文章总数（不过滤分类）：给状态栏显示用；查不出来返回 0
	static sqlite3_int64 count();
};
