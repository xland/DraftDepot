#pragma once
#include "Db.h"
#include <string>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.Collections.h> // 提供 IVector::Append 的定义，避免 C3779

using namespace winrt::Windows::Data::Json;

/**
 * 文章分类的数据访问：单层级分类的读 / 增 / 改名 / 删，外加初始分类写入。
 * 与 Article 平级，直接对外提供服务（Page 的 IPC 就调这里的静态方法）；
 * 数据库连接统一从 Db::get() 取，本类不持有连接。
 * 老库里遗留的 parent_id 由 Db::migrateToFlatCategories 压成 NULL，这里一律不读它。
 */
class Category
{
public:
	/// 读取全部分类，按 sort_order / id 返回单层扁平数组
	/// 每项：{ "id": <int>, "parentId": null, "name": <string> }
	/// parentId 恒为 null，只为兼容旧协议保留（见 Db/migrate_flat_categories.sql）
	static JsonArray load();
	/// 新增顶层分类；parentId 参数仅为兼容旧前端的 IPC 参数而留，实现里忽略。
	/// sort_order 取全表最大值 +1，排在末尾；返回新分类 id，失败返回 -1
	static sqlite3_int64 add(const std::wstring& name, sqlite3_int64 parentId);
	/// 改名；成功返回 true（id 不存在或名字为空返回 false）
	static bool rename(sqlite3_int64 id, const std::wstring& name);
	/// 删除分类，但只删"空分类"：名下挂着文章的一律不删，
	/// 并通过 reason 带一句给人看的原因（由 UI 弹出来），空串表示没挡住。
	/// 挡的理由：删完文章会散成未分类，等于悄悄打散了用户已有的归档，先让他自己挪走。
	/// 成功（且确实删到了行）返回 true；id 不存在时返回 false 并给出原因
	static bool remove(sqlite3_int64 id, std::wstring& reason);
	/// 分类总数：给状态栏显示用；查不出来返回 0
	static sqlite3_int64 count();
	/// 写入三个顶层初始分类（仅当分类表为空时）
	static void seed();
};
