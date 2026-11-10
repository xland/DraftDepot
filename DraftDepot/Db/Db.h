#pragma once
#include "../SQLite/sqlite3.h"

/**
 * 应用数据库：持有到 db.db 的持久连接（Db.cpp 里的文件级静态变量），负责启动时建库建表与 schema 升级。
 * 建表使用 IF NOT EXISTS，因此重复启动安全（不重复建）；一次性升级用 PRAGMA user_version 做幂等标记，
 * 升级前整库备份、包在事务里，失败只提示不结束进程（见 migrate_flat_categories.sql）。
 * 这里只管连接与 schema，具体数据的读写由 Category / Article 各自对外提供。
 */
namespace Db
{
	/// 打开数据目录下的 db.db；文件不存在则创建，执行建表 SQL，并把老库的多级分类压平成单层；
	/// 打开或建表失败时直接提示用户并退出进程，不会返回（升级失败则只提示、不退出）；
	/// 表都建好后写入分类的初始数据（由 Category 负责）
	void init();
	/// 取数据库连接；Category / Article 通过它执行 SQL
	sqlite3* get();
}
