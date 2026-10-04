#include "Util.h"

#include <chrono>

std::wstring Util::convertToWStr(const char* str)
{
    if (!str) return std::wstring();
    int count = MultiByteToWideChar(CP_UTF8, 0, str, -1, 0, 0);
    if (count == 0) return std::wstring();
    std::vector<wchar_t> buffer(count);
    MultiByteToWideChar(CP_UTF8, 0, str, -1, buffer.data(), count);
    return std::wstring(buffer.data(), buffer.size() - 1);
}
std::tuple<void*, DWORD> Util::getRes(const std::wstring& name)
{
    HRSRC hRes = FindResource(NULL, name.data(), RT_RCDATA);
    if (!hRes) {
        return std::make_tuple(nullptr, 0);
    }
    HGLOBAL hData = LoadResource(NULL, hRes);
    if (!hData) {
        return std::make_tuple(nullptr, 0);
    }
    void* pData = LockResource(hData);
    DWORD size = SizeofResource(NULL, hRes);
    return std::make_tuple(pData, size);
}
JsonObject Util::msgArgs(const JsonObject& param)
{
    if (param.HasKey(L"args") && param.GetNamedValue(L"args").ValueType() == JsonValueType::Object)
        return param.GetNamedObject(L"args");
    return JsonObject{};
}
std::wstring Util::argString(const JsonObject& args, const wchar_t* key)
{
    if (!args.HasKey(key)) return {};
    auto value = args.GetNamedValue(key);
    return value.ValueType() == JsonValueType::String ? std::wstring(value.GetString()) : std::wstring{};
}
sqlite3_int64 Util::argNumber(const JsonObject& args, const wchar_t* key)
{
    if (!args.HasKey(key)) return Util::NO_NUMBER;
    auto value = args.GetNamedValue(key);
    return value.ValueType() == JsonValueType::Number
        ? static_cast<sqlite3_int64>(value.GetNumber())
        : Util::NO_NUMBER;
}
long long Util::nowMillis()
{
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}