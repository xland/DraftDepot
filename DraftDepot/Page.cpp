#include "Env.h"
#include "Page.h"
#include "Window.h"
#include "WindowSite.h"
#include "Db/Category.h"
#include "Db/Article.h"
#include "Util.h"

#include <fstream>
#include <filesystem>

Page::Page(Window* win, ComPtr<ICoreWebView2>& webview) :win{ win }, webview{ webview }
{
    webview->AddWebResourceRequestedFilter(L"https://app.localhost/*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
    auto resRequestedCB = Callback<ICoreWebView2WebResourceRequestedEventHandler>(this, &Page::onRequest);
    webview->add_WebResourceRequested(resRequestedCB.Get(), nullptr);

    auto msgReceivedCB = Callback<ICoreWebView2WebMessageReceivedEventHandler>(this, &Page::onMsgReceived);
    webview->add_WebMessageReceived(msgReceivedCB.Get(), nullptr);

    auto reqPermissionCB = Callback<ICoreWebView2PermissionRequestedEventHandler>(this, &Page::onRequestPermission);
    webview->add_PermissionRequested(reqPermissionCB.Get(), nullptr);

    ComPtr<ICoreWebView2_2> webview2;
    this->webview.As(&webview2);
    auto domLoadedCB = Callback<ICoreWebView2DOMContentLoadedEventHandler>(this, &Page::onDomLoaded);
    webview2->add_DOMContentLoaded(domLoadedCB.Get(), nullptr);

    auto closeWindowCB = Callback<ICoreWebView2WindowCloseRequestedEventHandler>(this, &Page::onCloseWindow);
    webview->add_WindowCloseRequested(closeWindowCB.Get(), nullptr);

#ifdef _DEBUG
	// 调试：用 vite 开发服务器，改前端不必重新编译 exe
	webview->Navigate(L"http://localhost:5173");
#else
	// 发布：前端产物编进了 exe 资源（见 Resource.rc 里那块 dist 清单），走虚拟域名——
	// 请求由 onRequest 从资源里应答，一个 exe 就能独立跑，不依赖本机任何文件
	webview->Navigate(L"https://app.localhost/index.html");
#endif
}

void Page::emit(const JsonObject& eventData)
{
    std::wstring eventDataStr{ eventData.Stringify() };
    webview->PostWebMessageAsJson(eventDataStr.data());
}


HRESULT Page::onMsgReceived(ICoreWebView2* webview, ICoreWebView2WebMessageReceivedEventArgs* args)
{
    PWSTR jsonRaw;
    auto hr = args->get_WebMessageAsJson(&jsonRaw);
    if (FAILED(hr)) return S_OK;
    JsonObject param = JsonObject::Parse(jsonRaw);
    CoTaskMemFree(jsonRaw);
    auto method = param.GetNamedString(L"method");
    JsonObject result;
    result.SetNamedValue(L"id", JsonValue::CreateStringValue(param.GetNamedString(L"id")));
    if (method == L"showWindow") {
        win->show();
    }
    else if (method == L"hittest") {
        // args: { val }；val 是 HT_* 命中值，由前端 WindowBorder 给
        win->hittest(static_cast<int>(param.GetNamedObject(L"args").GetNamedNumber(L"val")));
    }
    else if (method == L"minimize") {
        win->minimize();
    }
    else if (method == L"maximize") {
        win->maximize();
    }
    else if (method == L"restore") {
        win->restore();
    }

    else if (method == L"getImageDir") {
        // 把图片目录句柄随回包发给 JS（自带回包逻辑，不走下面的统一 PostWebMessageAsJson）
        handleGetImageDir(result);
        return S_OK;
    }
    else if (method == L"getCategories") {
        // 返回数据放进名为 result 的字段，前端 Msg.resolve(msg.result) 才能取到
        JsonObject payload;
        payload.SetNamedValue(L"categories", Category::load());
        result.SetNamedValue(L"result", payload);
    }
    else if (method == L"getArticleTitles") {
        // 同上：只给标题，不带正文，也不分页。
        // args.categoryId 可选：不传（或不是数字）表示没有选中分类，加载全部
        JsonObject args = Util::msgArgs(param);
        sqlite3_int64 categoryId = Util::argNumber(args, L"categoryId");
        JsonObject payload;
        payload.SetNamedValue(L"articles", Article::loadTitles(categoryId));
        result.SetNamedValue(L"result", payload);
    }
    else if (method == L"getArticle") {
        // args: { id }；按 id 读单篇文章（含正文），给编辑器回填用。
        // 返回 { article: {...} }：id 不存在时 article 是空对象（前端按有没有 id 处理）
        JsonObject args = Util::msgArgs(param);
        JsonObject payload;
        payload.SetNamedValue(L"article", Article::loadArticle(Util::argNumber(args, L"id")));
        result.SetNamedValue(L"result", payload);
    }
    else if (method == L"createArticle") {
        // args: { title, content, categoryId? }；categoryId 省略/null 表示未分类。
        // 标题由前端保证不为空（空标题已替换成【未命名】）——title 列是 NOT NULL。
        // 把整篇新文章回给前端：它拿其中的 id 与 updatedAt 插进列表并选中
        JsonObject args = Util::msgArgs(param);
        sqlite3_int64 id = Article::addArticle(
            Util::argString(args, L"title"),
            Util::argString(args, L"content"),
            Util::argNumber(args, L"categoryId"));
        JsonObject payload;
        payload.SetNamedValue(L"article", Article::loadArticle(id));
        result.SetNamedValue(L"result", payload);
    }
    else if (method == L"updateArticle") {
        // args: { id, title, content }；改标题与正文，updated_at 顺带刷新。
        // 返回 { ok, updatedAt }：前端拿新的 updatedAt 去刷新列表行显示的时间
        JsonObject args = Util::msgArgs(param);
        sqlite3_int64 id = Util::argNumber(args, L"id");
        bool ok = Article::updateArticle(id, Util::argString(args, L"title"), Util::argString(args, L"content"));
        // 顺手把新的 updated_at 读回来给前端刷新列表行的时间显示
        // 顺手把新的 updated_at 读回来给前端刷新列表行的时间显示
        JsonObject payload;
        payload.SetNamedValue(L"ok", JsonValue::CreateBooleanValue(ok));
        auto fresh = Article::loadArticle(id);
        if (fresh.HasKey(L"updatedAt")) payload.SetNamedValue(L"updatedAt", fresh.GetNamedValue(L"updatedAt"));
        result.SetNamedValue(L"result", payload);
    }
    else if (method == L"addCategory") {
        // args: { name, parentId? }；parentId 省略或 null 表示建顶层分类。
        // 返回 { id }：前端拿它选中刚建好的分类
        JsonObject args = Util::msgArgs(param);
        JsonObject payload;
        payload.SetNamedValue(L"id", JsonValue::CreateNumberValue(
            static_cast<double>(Category::add(Util::argString(args, L"name"), Util::argNumber(args, L"parentId")))));
        result.SetNamedValue(L"result", payload);
    }
    else if (method == L"renameCategory") {
        // args: { id, name }；返回 { ok }
        JsonObject args = Util::msgArgs(param);
        JsonObject payload;
        payload.SetNamedValue(L"ok", JsonValue::CreateBooleanValue(
            Category::rename(Util::argNumber(args, L"id"), Util::argString(args, L"name"))));
        result.SetNamedValue(L"result", payload);
    }
    else if (method == L"removeArticle") {
        // args: { id }；删掉一篇。返回 { ok }：前端只在真的删到了行时才把列表行摘掉
        JsonObject args = Util::msgArgs(param);
        JsonObject payload;
        payload.SetNamedValue(L"ok", JsonValue::CreateBooleanValue(
            Article::removeArticle(Util::argNumber(args, L"id"))));
        result.SetNamedValue(L"result", payload);
    }
    else if (method == L"removeCategory") {
        // args: { id }；只删空分类：有子分类、或子树下挂着文章的会被挡回来，
        // 原因在 reason 里，前端直接弹给用户（见 Category::remove）
        JsonObject args = Util::msgArgs(param);
        std::wstring reason;
        bool ok = Category::remove(Util::argNumber(args, L"id"), reason);
        JsonObject payload;
        payload.SetNamedValue(L"ok", JsonValue::CreateBooleanValue(ok));
        payload.SetNamedValue(L"reason", JsonValue::CreateStringValue(reason));
        result.SetNamedValue(L"result", payload);
    }
    else if (method == L"getCounts") {
        // 无参数：状态栏左侧要的库级统计。与当前选中哪个分类无关，所以按整张表数，
        // 不复用 Article::loadTitles（那个是按分类过滤的，数出来的只是当前视图里的篇数）
        JsonObject payload;
        payload.SetNamedValue(L"categories", JsonValue::CreateNumberValue(static_cast<double>(Category::count())));
        payload.SetNamedValue(L"articles", JsonValue::CreateNumberValue(static_cast<double>(Article::count())));
        result.SetNamedValue(L"result", payload);
    }
    else if (method == L"openSite") {
        // args: { type, title, html }；前端点"发布到 xxx"按钮时触发，新开一个 site 窗口。
        // type 决定开哪个站点（公众号 "WeiXin"、CSDN "CSDN" ...）：打开哪个地址由 WindowSite 按 type 自己算
        // ——微信会拿 site 表里存的 token 直接进编辑页，没 token 才落到登录首页，所以 URL 不再由前端给。
        // title/html 是发布那一刻的文章标题与正文 HTML，暂存在 WindowSite 上，等站点脚本进到对方
        // 编辑器后调 getArticle 取走（两个窗口各自是一个 WebView2，内容只能经这里中转）。
        JsonObject args = Util::msgArgs(param);
        std::wstring type = Util::argString(args, L"type");
        if (!type.empty()) {
            WindowSite::create(type,
                Util::argString(args, L"title"),
                Util::argString(args, L"html"));
        }
    }
    else {
        // 未知方法回一个 error：前端 Msg.invoke 会 reject，而不是静默 resolve(undefined)。
        // 之前"原生侧改了却忘了重新编译 exe"就是被静默吞掉的，补上这条能直接暴露出来
        std::wstring message = L"unknown method: " + std::wstring(method.c_str());
        result.SetNamedValue(L"error", JsonValue::CreateStringValue(message));
    }
    auto resultStr = result.Stringify();
    webview->PostWebMessageAsJson(resultStr.data());
    return S_OK;
}

HRESULT Page::onCloseWindow(ICoreWebView2* sender, IUnknown* args)
{
    PostMessage(win->hwnd, WM_CLOSE, 0, 0);
    return S_OK;
}

HRESULT Page::onDomLoaded(ICoreWebView2* sender, ICoreWebView2DOMContentLoadedEventArgs* args)
{
    return S_OK;
}

HRESULT Page::onRequestPermission(ICoreWebView2* webview, ICoreWebView2PermissionRequestedEventArgs* args)
{
    args->put_State(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
    return S_OK;
}


HRESULT Page::onRequest(ICoreWebView2* webview, ICoreWebView2WebResourceRequestedEventArgs* args)
{
    ComPtr<ICoreWebView2WebResourceRequest> request;
    args->get_Request(&request);
    LPWSTR rawUri = nullptr;
    request->get_Uri(&rawUri);
    std::wstring url(rawUri);
    CoTaskMemFree(rawUri);
    size_t queryPos = url.find(L'?');
    size_t end = (queryPos != std::wstring::npos) ? queryPos : url.length();
    std::wstring resName = url.substr(22, end - 22); //22是“https://app.localhost/”的长度
    // 光有域名（https://app.localhost/）或以 / 结尾的，都当要首页
    if (resName.empty() || resName.back() == L'/') resName += L"index.html";
    HRSRC hRes = FindResource(NULL, resName.data(), RT_RCDATA);
    if (!hRes) {
        // 内嵌资源未命中时，回退到数据目录：读取 dataPath/<resName> 同名文件
        auto hr = serveFileFromDataPath(args, resName);
        // 文件也不存在时保持默认请求失败行为（不 put_Response，让上层按 404 处理）
        return hr == S_OK ? S_OK : hr;
    }
    HGLOBAL hData = LoadResource(NULL, hRes);
    if (!hData) return S_OK;
    void* pData = LockResource(hData);
    DWORD size = SizeofResource(NULL, hRes);
    ComPtr<IStream> stream = SHCreateMemStream((const BYTE*)pData, size);
    auto ct = getContentType(resName);
    ComPtr<ICoreWebView2WebResourceResponse> response;
    Env::getWebViewEnv()->CreateWebResourceResponse(stream.Get(), 200, L"OK", ct.data(), &response);
    args->put_Response(response.Get());
    return S_OK;
}

std::wstring Page::getContentType(const std::wstring& fileName)
{
    static const std::unordered_map<std::string, std::wstring> mimeTypes = {
        {".html", L"Content-Type: text/html"},
        {".htm",  L"Content-Type: text/html"},
        {".js",   L"Content-Type: application/javascript"},
        {".css",  L"Content-Type: text/css"},
        {".json", L"Content-Type: application/json"},
        {".png",  L"Content-Type: image/png"},
        {".jpg",  L"Content-Type: image/jpeg"},
        {".jpeg", L"Content-Type: image/jpeg"},
        {".gif",  L"Content-Type: image/gif"},
        {".svg",  L"Content-Type: image/svg+xml"},
        {".ico",  L"Content-Type: image/x-icon"},
        {".woff", L"Content-Type: font/woff"},
        {".woff2",L"Content-Type: font/woff2"},
        {".ttf",  L"Content-Type: font/ttf"},
        {".eot",  L"Content-Type: application/vnd.ms-fontobject"},
        {".txt",  L"Content-Type: text/plain"},
        {".wasm", L"Content-Type: application/wasm"},
        {".mp3",  L"Content-Type: audio/mpeg"},
        {".mp4",  L"Content-Type: video/mp4"}
    };
    std::filesystem::path path(fileName);
    auto ext = path.extension().string();
    std::transform(ext.begin(), ext.end(), ext.begin(), ::tolower);
    auto it = mimeTypes.find(ext);
    if (it != mimeTypes.end()) {
        return it->second;
    }
    return L"Content-Type: application/octet-stream";
}

HRESULT Page::serveFileFromDataPath(ICoreWebView2WebResourceRequestedEventArgs* args, const std::wstring& resName)
{
    // resName 直接来自 URL（可含子目录，如 images/xxx.png）：规范化后必须仍在数据目录内，
    // 挡掉 ../ 之类跳出目录的请求，同时保留了对 images 子目录的支持
    if (resName.empty()) return S_FALSE;
    auto base = Env::getDataPath().lexically_normal();
    auto filePath = (base / resName).lexically_normal();
    std::error_code ec;
    auto rel = std::filesystem::relative(filePath, base, ec).wstring();
    if (ec || rel.empty() || rel == L".." || rel.rfind(L"..\\", 0) == 0 || rel.rfind(L"../", 0) == 0) {
        return S_FALSE;
    }

    auto sz = std::filesystem::file_size(filePath, ec);
    if (ec) return S_FALSE; // 文件不存在，交由调用方决定
    std::ifstream f(filePath, std::ios::binary);
    std::string bytes((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    if (bytes.empty()) return S_FALSE;
    ComPtr<IStream> stream = SHCreateMemStream((const BYTE*)bytes.data(), (UINT)bytes.size());
    auto ct = getContentType(resName);
    ComPtr<ICoreWebView2WebResourceResponse> response;
    Env::getWebViewEnv()->CreateWebResourceResponse(stream.Get(), 200, L"OK", ct.data(), &response);
    args->put_Response(response.Get());
    return S_OK;
}

void Page::handleGetImageDir(JsonObject& result)
{
    // 只把图片子目录交给 JS：数据目录里还放着 SQLite 库和 WebView2 的用户数据，
    // 整个目录给 READ_WRITE 等于让前端能读写甚至删掉数据库
    std::error_code ec;
    auto dir = Env::getDataPath() / L"images";
    std::filesystem::create_directories(dir, ec);

    ComPtr<ICoreWebView2Environment14> env14;
    ComPtr<ICoreWebView2FileSystemHandle> dirHandle;
    ComPtr<ICoreWebView2_23> webview23;
    if (!ec
        && SUCCEEDED(Env::getWebViewEnv()->QueryInterface(IID_PPV_ARGS(&env14)))
        && SUCCEEDED(env14->CreateWebFileSystemDirectoryHandle(dir.c_str(),
            COREWEBVIEW2_FILE_SYSTEM_HANDLE_PERMISSION_READ_WRITE, &dirHandle))
        && SUCCEEDED(webview->QueryInterface(IID_PPV_ARGS(&webview23))))
    {
        IUnknown* items[] = { dirHandle.Get() };
        ComPtr<ICoreWebView2ObjectCollection> collection;
        if (SUCCEEDED(env14->CreateObjectCollection(1, items, &collection)))
        {
            // 自带回包：句柄只能随附加对象一起发，成功后直接返回
            auto json = result.Stringify();
            webview23->PostWebMessageAsJsonWithAdditionalObjects(json.c_str(), collection.Get());
            return;
        }
    }
    result.SetNamedValue(L"error", JsonValue::CreateStringValue(L"获取图片目录失败"));
    auto json = result.Stringify();
    webview->PostWebMessageAsJson(json.c_str());
}
