#pragma once
#include <Windows.h>
#include <vector>
#include <string>
#include <tuple>
#include "SQLite/sqlite3.h"
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.Collections.h> // 提供 IMap::HasKey / IVector::Append 的定义，避免 C3779

using namespace winrt::Windows::Data::Json;

class Util
{
public:
	static std::wstring convertToWStr(const char* str);
	static std::tuple<void*, DWORD> getRes(const std::wstring& name);
	/// 取 IPC 消息里的 args 对象；没有 args、或它不是对象时返回空对象（后续 HasKey 一律 false）
	static JsonObject msgArgs(const JsonObject& param);
	/// 取 args 里的字符串参数；缺失或类型不对时返回空串
	static std::wstring argString(const JsonObject& args, const wchar_t* key);
	/// 取 args 里的数字参数；缺失或类型不对时返回 NO_NUMBER（调用方拿它当"这个参数没传"）
	static sqlite3_int64 argNumber(const JsonObject& args, const wchar_t* key);
	/// argNumber 的"没有这个参数"返回值。-1：所有 IPC 约定负数都不是合法 id
	static constexpr sqlite3_int64 NO_NUMBER = -1;
	/// 程序图标的资源 id：Resource.rc 里手写的那一行 `100 ICON`（指向 Doc\logo.ico）用的是裸数字，
	/// 没有符号名，所以在这里记一个。主窗口与 site 窗口的标题栏、任务栏都挂它（见各自的 createWin）
	static constexpr int appIconId = 100;
	/// 当前时刻的毫秒数，与 JS 的 Date.now() 同口径（Unix 纪元起）。
	/// 拼 URL 时要带上它：带着才是"这一刻"的请求，不然页面或接口可能给回缓存的那一份
	static long long nowMillis();
};
