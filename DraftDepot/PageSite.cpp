#include <unordered_map>

#include "Env.h"
#include "PageSite.h"
#include "WindowSite.h"
#include "Db/ImageSite.h"
#include "Util.h"
#include <winrt/Windows.Foundation.Collections.h> // 提供 IMap::HasKey 的定义，避免 C3779

namespace
{
	/// 各平台的落地首页：没有可用 token（或该平台还没做"直奔编辑页"）时打开这里，让用户自己登录。
	/// 落地页与注入脚本（injectSiteScript 按同一个 type 取 <type>.js）是同一件事的两半：
	/// 开哪个页面，就决定了那里等着的是哪份脚本。所以两条都放在本文件里，
	/// 加平台时顺着一处改完，不会登记了脚本却漏了落地页
	const std::unordered_map<std::wstring, std::wstring> siteHome = {
		{ L"WeiXin", L"https://mp.weixin.qq.com/" },
		// 知乎：直接给写文章的页面。没登录会被它送到登录页，登录成功后又自动回到这个地址，
		// 所以不需要像微信那样拿 token 拼编辑页（注入脚本 JS/ZhiHu.js 在编辑页里等文章灌入）
		{ L"ZhiHu",  L"https://zhuanlan.zhihu.com/write" },
		// CSDN：给 Markdown 编辑器那条写作页（左边源码右边预览），而不是 mp.csdn.net 的富文本编辑器。
		// ?not_checkout=1 是它"新建文章"的入口，不带会被落到"接着编上一篇草稿"上。
		// 选 Markdown 那条是因为代码块：写成围栏 + 语言，语言本来就在围栏上，而富文本那条得把代码块
		// 拼成 CKEditor 的 codesnippet 组件，还得随文带一份着色，代价大且容易失效（详见 JS/CSDN.js
		// 文件头）。没登录会被它送到登录页，登录成功后又自动回到这个地址（注入脚本在写作页里等）
		{ L"CSDN",   L"https://editor.csdn.net/md/?not_checkout=1" },
		// 博客园：直接给写文章的页面，没登录会被它送到登录页，登录成功后又自动回来（与知乎同一套）
		{ L"CnBlogs", L"https://i.cnblogs.com/posts/edit" },
		// 开源中国：直接给写文章的页面（AI 写作页），没登录会被它送到登录页，登录成功后又自动回来。
		// 地址里的 u/1432189 是账号 id，换账号登录要同步改这里（脚本那边只认 /blog/ai-write 结尾）
		{ L"OSC",    L"https://my.oschina.net/u/1432189/blog/ai-write" },
		// 掘金：直接给新建草稿的页面，没登录会被它送到登录页，登录成功后又自动回来（与知乎同一套）
		{ L"JueJin", L"https://juejin.cn/editor/drafts/new?v=2" },
		// InfoQ：给草稿箱。它没有固定的"新建文章"地址（编辑页是 /draft/<id>，id 要建草稿时才给），
		// 所以由注入脚本在草稿箱上调建草稿接口拿到 id 再跳过去（见 JS/InfoQ.js）
		{ L"InfoQ",  L"https://xie.infoq.cn/draftbox" },
		// 51CTO：直接给发布文章的页面（Markdown 编辑器），没登录会被它送到登录页，登录成功后又自动回来
		{ L"51CTO",  L"https://blog.51cto.com/blogger/publish" },
		// 阿里云开发者社区：直接给新建文章的页面（Markdown 编辑器），没登录会被它送到登录页，
		// 登录成功后又自动回来（与知乎同一套）
		{ L"AliYun", L"https://developer.aliyun.com/article/new#/" },
	};
}

PageSite::PageSite(WindowSite* win, ComPtr<ICoreWebView2>& webview)
	: win{ win }, webview{ webview }
{
	// 起始 URL 由本类按窗口的 type + 该站点存下来的配置算出来（见 buildStartUrl）。
	// 放在函数体里算而不是成员初始化列表：它要读 win->type / win->config，写进列表就等于把正确性
	// 押在成员的声明顺序上（win 必须排在头一个）。这里没那个必要，函数体里一目了然
	startUrl = buildStartUrl();

	auto msgReceivedCB = Callback<ICoreWebView2WebMessageReceivedEventHandler>(this, &PageSite::onMsgReceived);
	webview->add_WebMessageReceived(msgReceivedCB.Get(), nullptr);

	auto closeWindowCB = Callback<ICoreWebView2WindowCloseRequestedEventHandler>(this, &PageSite::onCloseWindow);
	webview->add_WindowCloseRequested(closeWindowCB.Get(), nullptr);

	auto titleChangedCB = Callback<ICoreWebView2DocumentTitleChangedEventHandler>(this, &PageSite::onTitleChange);
	webview->add_DocumentTitleChanged(titleChangedCB.Get(), nullptr);

	// 脚本要在首屏文档创建时就跑起来，所以先注册再导航
	injectSiteScript(webview);
	webview->Navigate(startUrl.c_str());
}

PageSite::~PageSite()
{
}

std::wstring PageSite::buildStartUrl()
{
	// 只有微信会临时拼 URL：它有 token 就直接进"新建图文"的编辑页，省得用户自己再点一次。
	// config 是窗口加载的那一份（脚本调 setParam 回传 token 时同步更新），但本函数只在建 PageSite
	// 时跑这一遍——那时拿到的就是库里现成的 token，拿不到就照旧落首页让用户登录
	if (win->type == L"WeiXin")
	{
		if (win->config.HasKey(L"token"))
		{
			std::wstring token{ win->config.GetNamedString(L"token") };
			if (!token.empty())
				return std::wstring{ L"https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2" }
					+ L"&action=edit&isNew=1&type=77&createType=0&token=" + token
					+ L"&lang=zh_CN&timestamp=" + std::to_wstring(Util::nowMillis());
		}
		// 没 token（或 token 是空串）：只能开首页让用户登录，登录后由注入脚本把新 token 带回来
		return siteHome.at(L"WeiXin");
	}

	// 其他平台：落在各自的落地页上；没登记过的 type 返回空串（Navigate 到空串等于不导航）
	auto it = siteHome.find(win->type);
	return it == siteHome.end() ? std::wstring{} : it->second;
}

HRESULT PageSite::onMsgReceived(ICoreWebView2* webview, ICoreWebView2WebMessageReceivedEventArgs* args)
{
	PWSTR jsonRaw;
	auto hr = args->get_WebMessageAsJson(&jsonRaw);
	if (FAILED(hr)) return S_OK;
	JsonObject param = JsonObject::Parse(jsonRaw);
	CoTaskMemFree(jsonRaw);
	auto method = param.GetNamedString(L"method");
	JsonObject result;
	// 站点脚本（如 WeiXin.js）直接 postMessage，未必带 id；没有就不回 id，免得 GetNamedString 抛异常
	if (param.HasKey(L"id")) {
		result.SetNamedValue(L"id", JsonValue::CreateStringValue(param.GetNamedString(L"id")));
	}
	if (method == L"setParam") {
		// args: { key, value }；站点脚本回传站点参数（微信的 token），由 WindowSite 落库
		win->setParam(param, result);
	}
	else if (method == L"getArticle") {
		// args: 无；站点脚本进了对方编辑器后来取"待发布的文章"（openSite 时塞进来的），由 WindowSite 交出
		win->takeArticle(result);
	}
	else if (method == L"setPublished") {
		// args: 无；站点脚本把文章灌进对方编辑器之后调用，由 WindowSite 记下"这一轮已经发过了"
		win->markPublished(result);
	}
	else if (method == L"getPublished") {
		// args: 无；站点脚本（每个文档重跑一遍）进来先问一句：这一轮是不是已经发过了
		win->isPublished(result);
	}
	else if (method == L"getImageDir") {
		// args: 无；自带回包：目录句柄只能随附加对象一起发，成功后直接返回
		handleGetImageDir(result);
		return S_OK;
	}
	else if (method == L"getCookie") {
		// args: { url?, name?, names? }；自带回包：CookieManager 是回调式的，回包在回调里发
		handleGetCookie(param, result);
		return S_OK;
	}
	else if (method == L"getImageUrl") {
		// args: { name }；站点脚本传图前先查这张图在本站点传过没有，回 { url }（没传过是空串）
		handleGetImageUrl(param, result);
	}
	else if (method == L"setImageUrl") {
		// args: { name, url }；传成功后把地址记下来，下次发布直接取，不必再传一遍
		handleSetImageUrl(param, result);
	}
	else if (method == L"notice") {
		// args: { text, url? }；站点脚本没法往下走时提示一句，之后开浏览器 + 关窗（见 handleNotice）
		handleNotice(param, result);
	}
	else {
		// 未知方法回 error：与主 Page 行为对齐，避免前端 invoke 静默 resolve(undefined)
		std::wstring message = L"unknown method: " + std::wstring(method.c_str());
		result.SetNamedValue(L"error", JsonValue::CreateStringValue(message));
	}
	auto resultStr = result.Stringify();
	webview->PostWebMessageAsJson(resultStr.data());
	return S_OK;
}

void PageSite::handleGetImageDir(JsonObject& result)
{
	// 数据目录下的 images 子目录：与主窗口 Page::handleGetImageDir 是同一个目录，但这里只给 READ。
	// 站点脚本只把图读出来传对方的图床，给它 READ_WRITE 等于让对方页面能在我们的图片目录里增删改写
	std::error_code ec;
	auto dir = Env::getDataPath() / L"images";
	std::filesystem::create_directories(dir, ec);

	ComPtr<ICoreWebView2Environment14> env14;
	ComPtr<ICoreWebView2FileSystemHandle> dirHandle;
	ComPtr<ICoreWebView2_23> webview23;
	if (!ec
		&& SUCCEEDED(Env::getWebViewEnv()->QueryInterface(IID_PPV_ARGS(&env14)))
		&& SUCCEEDED(env14->CreateWebFileSystemDirectoryHandle(dir.c_str(),
			COREWEBVIEW2_FILE_SYSTEM_HANDLE_PERMISSION_READ_ONLY, &dirHandle))
		&& SUCCEEDED(webview->QueryInterface(IID_PPV_ARGS(&webview23))))
	{
		IUnknown* items[] = { dirHandle.Get() };
		ComPtr<ICoreWebView2ObjectCollection> collection;
		if (SUCCEEDED(env14->CreateObjectCollection(1, items, &collection)))
		{
			// 自带回包：句柄只能随附加对象一起发，成功后直接返回。
			// 脚本那边 DDMsg.invokeWithObjects("getImageDir") 拿到的 objects[0] 就是
			// FileSystemDirectoryHandle，之后 getFileHandle(文件名) 取文件全在它自己那边完成
			auto json = result.Stringify();
			webview23->PostWebMessageAsJsonWithAdditionalObjects(json.c_str(), collection.Get());
			return;
		}
	}
	result.SetNamedValue(L"error", JsonValue::CreateStringValue(L"获取图片目录失败"));
	auto json = result.Stringify();
	webview->PostWebMessageAsJson(json.c_str());
}

void PageSite::handleGetCookie(JsonObject& param, JsonObject& result)
{
	JsonObject args = Util::msgArgs(param);

	// 取哪个源的 cookie：不给就用本窗口打开的那个地址——站点脚本要的通常就是自己这一个
	// （startUrl 是开窗时的起始地址，页面跳转后不跟着变；够用，脚本要读的都是自己站点的 cookie）
	std::wstring target = startUrl;
	std::wstring givenUrl = Util::argString(args, L"url");
	if (!givenUrl.empty()) target = givenUrl;

	// 要哪几个 cookie：name（单个）/ names（多个）都行；都不给就把这个源下的 cookie 全给
	std::vector<std::wstring> names;
	std::wstring name = Util::argString(args, L"name");
	if (!name.empty()) names.push_back(name);
	if (args.HasKey(L"names")) {
		auto raw = args.GetNamedValue(L"names");
		if (raw.ValueType() == JsonValueType::Array) {
			for (auto&& item : raw.GetArray()) {
				// 数组里混进非字符串（null / 数字）就跳过：调用方写错了也不至于整条消息失败
				if (item.ValueType() == JsonValueType::String) {
					names.push_back(std::wstring{ item.GetString().c_str() });
				}
			}
		}
	}

	ComPtr<ICoreWebView2_2> webview2;
	ComPtr<ICoreWebView2CookieManager> cookieMgr;
	if (FAILED(webview->QueryInterface(IID_PPV_ARGS(&webview2)))
		|| FAILED(webview2->get_CookieManager(&cookieMgr)))
	{
		result.SetNamedValue(L"error", JsonValue::CreateStringValue(L"取不到 CookieManager"));
		auto json = result.Stringify();
		webview->PostWebMessageAsJson(json.c_str());
		return;
	}

	// GetCookies 是回调式的，回包只能在回调里发：webview 拷一份 ComPtr 跟着回调走——
	// 那会儿本对象可能已经随着窗口关掉没了，但 webview 还在就还能把包发出去
	ComPtr<ICoreWebView2> poster = webview;
	JsonObject reply = result;
	cookieMgr->GetCookies(target.c_str(),
		Callback<ICoreWebView2GetCookiesCompletedHandler>(
			[poster, reply, names](HRESULT errorCode, ICoreWebView2CookieList* list) -> HRESULT
			{
				JsonObject out = reply; // 拷一份再往里塞结果，免得动到捕获的那份（回调不带 mutable）
				if (FAILED(errorCode) || !list) {
					out.SetNamedValue(L"error", JsonValue::CreateStringValue(L"读取 cookie 失败"));
					auto failed = out.Stringify();
					poster->PostWebMessageAsJson(failed.c_str());
					return S_OK;
				}
				JsonObject values;
				UINT count = 0;
				list->get_Count(&count);
				for (UINT i = 0; i < count; i++) {
					ComPtr<ICoreWebView2Cookie> cookie;
					if (FAILED(list->GetValueAtIndex(i, &cookie)) || !cookie) continue;
					PWSTR nameRaw = nullptr;
					if (FAILED(cookie->get_Name(&nameRaw)) || !nameRaw) continue;
					std::wstring cookieName(nameRaw);
					CoTaskMemFree(nameRaw);
					// 指定了名字就只交这几个：别把整站 cookie（含 HttpOnly 的那些）都递给网页
					bool wanted = names.empty();
					for (const auto& wanted2 : names) {
						if (wanted2 == cookieName) {
							wanted = true;
							break;
						}
					}
					if (!wanted) continue;
					PWSTR valueRaw = nullptr;
					if (FAILED(cookie->get_Value(&valueRaw)) || !valueRaw) continue;
					values.SetNamedValue(cookieName.c_str(), JsonValue::CreateStringValue(valueRaw));
					CoTaskMemFree(valueRaw);
				}
				// 一律回"名字 → 值"的字典：脚本那边 cookies.ticket_id 这样取，给几个名字都一样
				out.SetNamedValue(L"result", values);
				auto json = out.Stringify();
				poster->PostWebMessageAsJson(json.c_str());
				return S_OK;
			}).Get());
}

void PageSite::handleGetImageUrl(JsonObject& param, JsonObject& result)
{
	JsonObject args = Util::msgArgs(param);
	auto name = Util::argString(args, L"name");
	// 站点名用窗口 type（跟 site 表的 name 是同一套），不由脚本传：脚本按站点各写一份，
	// 让它传就得在四个地方各写对一个字符串，错了会把地址记到别的站点名下
	auto url = ImageSite::urlOf(name, win->type);

	// 没传过才是常态（这篇头一回发）：给空 url，脚本那边照旧传一次
	JsonObject value;
	value.SetNamedValue(L"url", JsonValue::CreateStringValue(url));
	result.SetNamedValue(L"result", value);
}

void PageSite::handleSetImageUrl(JsonObject& param, JsonObject& result)
{
	JsonObject args = Util::msgArgs(param);
	auto name = Util::argString(args, L"name");
	auto url = Util::argString(args, L"url");
	ImageSite::save(name, win->type, url);
}

void PageSite::handleNotice(JsonObject& param, JsonObject& result)
{
	JsonObject args = Util::msgArgs(param);
	auto text = Util::argString(args, L"text");
	auto link = Util::argString(args, L"url");

	// 模态：等用户点确定才往下走，顺序不能反——先开浏览器再弹框等于还没看提示就把人送走了
	MessageBox(win->hwnd, text.c_str(), L"提示", MB_OK | MB_ICONINFORMATION);
	// 系统默认浏览器打开：站点脚本在网页上下文里只能改自己的 location，开不了外部浏览器
	if (!link.empty()) ShellExecute(nullptr, L"open", link.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
	win->close();
	result.SetNamedValue(L"result", JsonValue::CreateBooleanValue(true));
}

HRESULT PageSite::onCloseWindow(ICoreWebView2* sender, IUnknown* args)
{
	PostMessage(win->hwnd, WM_CLOSE, 0, 0);
	return S_OK;
}

HRESULT PageSite::onTitleChange(ICoreWebView2* sender, IUnknown* args)
{
	PWSTR title;
	webview->get_DocumentTitle(&title);
	SetWindowText(win->hwnd, title);
	CoTaskMemFree(title);
	return S_OK;
}

void PageSite::injectSiteScript(ComPtr<ICoreWebView2>& webview)
{
	// 站点脚本按窗口 type 同名取资源（Resource.rc 里以 RCDATA 挂进来，type "WeiXin" → WeiXin.js）；
	// 没有对应资源的平台（type 为空，或还没写脚本）就不注入，site 窗口当普通浏览器用
	auto [siteData, siteSize] = Util::getRes(win->type + L".js");
	if (!siteData || siteSize == 0) return;

	// 拼在站点脚本前面的公共脚本，顺序即依赖顺序（脚本直接取 window 上的那个对象用）：
	//   Msg.js     → window.DDMsg：跟 native 说话，不用各自再写一遍 postMessage / 回包配对
	//   Content.js → window.DDContent：收拾正文形态用到的共用工具（代码语言表、代码块遍历、HTML 解析）
	//   Images.js  → window.DDImages：取图片文件、传图床、把图床地址换回正文（要用上 DDMsg / DDContent）
	//   Mask.js    → window.DDMask：同步期间的整页遮罩与提示
	// 各家不同的加工（微信的段落摊平、知乎的代码块标语言…）留在各自的站点脚本里
	std::string scriptUtf8;
	for (const wchar_t* name : { L"Msg.js", L"Content.js", L"Images.js", L"Mask.js" })
	{
		auto [data, size] = Util::getRes(name);
		if (!data || size == 0) continue;
		// 换行 + 分号隔开两段：免得上一段末尾的行注释把下一段开头吞掉
		if (!scriptUtf8.empty()) scriptUtf8 += "\n;\n";
		scriptUtf8.append(static_cast<const char*>(data), size);
	}
	scriptUtf8 += "\n;\n";
	scriptUtf8.append(static_cast<const char*>(siteData), siteSize);

	// 脚本文档是 UTF-8，而 AddScriptToExecuteOnDocumentCreated 要 UTF-16
	auto script = Util::convertToWStr(scriptUtf8.c_str());
	// 注册后每次文档创建（含首屏、跳转、iframe）都会自动执行，无需关心返回值
	webview->AddScriptToExecuteOnDocumentCreated(script.c_str(), nullptr);
}
