#include "Env.h"
#include "WindowSite.h"
#include "PageSite.h"
#include "Util.h"
#include "Db/Site.h"

/// site 窗口的全局注册表。关 site 窗口不影响主进程；主进程退出由主 Window::onDestroy 触发。
std::unordered_map<HWND, std::unique_ptr<WindowSite>> windowsSite;

WindowSite::WindowSite(const std::wstring& type, const std::wstring& articleTitle, const std::wstring& articleHtml)
	: type{ type }, config{ Site::load(type) }
	, articleTitle{ articleTitle }, articleHtml{ articleHtml }
{
	// 建窗即加载站点配置：Db 在 Env::init 阶段就已就绪，这里拿到的必然是可用连接。
	// 没配过任何参数的站点（或 type 为空）拿到的是空 JsonObject，按"没有配置"处理
}

// 见 WindowSite.h 的说明：unique_ptr<PageSite> 的析构要实例化在 PageSite 完整可见的本文件
WindowSite::~WindowSite()
{
}

WindowSite* WindowSite::create(const std::wstring& type,
	const std::wstring& articleTitle, const std::wstring& articleHtml)
{
	auto win = std::make_unique<WindowSite>(type, articleTitle, articleHtml);
	win->createWin();
	auto result = win.get();
	windowsSite.insert({ win->hwnd, std::move(win) });
	return result;
}

LRESULT WindowSite::winMsg(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
	auto self = reinterpret_cast<WindowSite*>(GetWindowLongPtr(hwnd, GWLP_USERDATA));
	if (!self) return DefWindowProc(hwnd, msg, wParam, lParam);
	if (msg == WM_SIZE) {
		if (self->ctrl) {
			RECT bounds;
			GetClientRect(hwnd, &bounds);
			self->ctrl->put_Bounds(bounds);
		}
	}
	else if (msg == WM_DESTROY) {
		self->onDestroy();
	}
	return DefWindowProc(hwnd, msg, wParam, lParam);
}

void WindowSite::createWin()
{
	WNDCLASSEXW wcex;
	wcex.cbSize = sizeof(WNDCLASSEX);
	wcex.style = CS_HREDRAW | CS_VREDRAW;
	wcex.lpfnWndProc = &WindowSite::winMsg;
	wcex.cbClsExtra = 0;
	wcex.cbWndExtra = 0;
	wcex.hInstance = GetModuleHandle(nullptr);
	// 标题栏左侧挂小图标、任务栏与 Alt+Tab 挂大图标，都用资源里那个 logo。
	// 用 LoadImage 按系统各自的图标尺寸取，ico 里有多帧时才能挑到最清晰的一帧（LoadIcon 只给默认尺寸）
	wcex.hIcon = (HICON)LoadImage(wcex.hInstance, MAKEINTRESOURCE(Util::appIconId), IMAGE_ICON,
		GetSystemMetrics(SM_CXICON), GetSystemMetrics(SM_CYICON), LR_DEFAULTCOLOR);
	wcex.hIconSm = (HICON)LoadImage(wcex.hInstance, MAKEINTRESOURCE(Util::appIconId), IMAGE_ICON,
		GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), LR_DEFAULTCOLOR);
	wcex.hCursor = LoadCursor(nullptr, IDC_ARROW);
	wcex.hbrBackground = (HBRUSH)COLOR_WINDOW;
	wcex.lpszMenuName = nullptr;
	wcex.lpszClassName = L"DraftDepotSite";
	RegisterClassEx(&wcex);
	// 位置 (350,350) 错开主窗口的 (200,300)；1200x800 与主窗口一致；WS_OVERLAPPEDWINDOW 自带
	// 标准标题栏、最小化/最大化/关闭按钮、可拖动改大小，所以不再像主窗口那样自绘/扩展 DWM 边框。
	// 标题先用站点类型兜底，网页加载完成后由 PageSite::onTitleChange 换成 document.title
	auto title = type.empty() ? std::wstring{ L"DraftDepot" } : type;
	hwnd = CreateWindowEx(0, wcex.lpszClassName, title.c_str(), WS_OVERLAPPEDWINDOW,
		350, 350, 1200, 800, nullptr, nullptr, wcex.hInstance, nullptr);
	SetWindowLongPtr(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(this));
	// 打开即最大化：site 窗口是给发布平台用的，需要尽可能大的可视区，省得用户再去点最大化按钮
	ShowWindow(hwnd, SW_SHOWMAXIMIZED);
	auto wvEnv = Env::getWebViewEnv();
	auto ctrlReadyCB = Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(this, &WindowSite::onCtrlReady);
	wvEnv->CreateCoreWebView2Controller(hwnd, ctrlReadyCB.Get());
}

void WindowSite::close()
{
	// 见 WindowSite.h：投完就回来，销毁等窗口消息自己走完
	PostMessage(hwnd, WM_CLOSE, 0, 0);
}

void WindowSite::setParam(const JsonObject& params, JsonObject& result)
{
	JsonObject args = Util::msgArgs(params);
	std::wstring key = Util::argString(args, L"key");
	std::wstring value = Util::argString(args, L"value");

	bool ok = false;
	bool changed = false;
	if (!type.empty() && !key.empty())
	{
		// 先跟内存里已加载的 config 比：一样就不动数据库（脚本每 800ms 轮一次，别反复写盘）
		std::wstring old = config.HasKey(key) ? std::wstring{ config.GetNamedString(key) } : std::wstring{};
		if (old != value)
		{
			changed = Site::set(type, key, value);
			if (changed) config.SetNamedValue(key, JsonValue::CreateStringValue(value));
		}
		ok = true;
	}
	result.SetNamedValue(L"ok", JsonValue::CreateBooleanValue(ok));
	result.SetNamedValue(L"changed", JsonValue::CreateBooleanValue(changed));
}

void WindowSite::takeArticle(JsonObject& result)
{
	JsonObject article;
	article.SetNamedValue(L"title", JsonValue::CreateStringValue(articleTitle));
	article.SetNamedValue(L"html", JsonValue::CreateStringValue(articleHtml));
	articleTitle.clear();
	articleHtml.clear();
	result.SetNamedValue(L"result", article);
}

void WindowSite::markPublished(JsonObject& result)
{
	published = true;
	result.SetNamedValue(L"ok", JsonValue::CreateBooleanValue(true));
}

void WindowSite::isPublished(JsonObject& result)
{
	// 值一律放在 result 下：DDMsg.invoke 只把回包里的 result 字段交给调用方（见 Msg.js 的 onMessage），
	// 写在根上会被丢掉——published 拿回来永远是 false，"发完别再把人拽回编辑页"这条就一直不生效。
	// 同层的几个（takeArticle / handleGetImageUrl / getCookie）本来就是这么写的
	JsonObject value;
	value.SetNamedValue(L"published", JsonValue::CreateBooleanValue(published));
	result.SetNamedValue(L"result", value);
}

HRESULT WindowSite::onCtrlReady(HRESULT result, ICoreWebView2Controller* ctrl)
{
	this->ctrl = ctrl;
	ComPtr<ICoreWebView2> webview;
	ctrl->get_CoreWebView2(&webview);
	RECT bounds;
	GetClientRect(hwnd, &bounds);
	ctrl->put_Bounds(bounds);
	// 起始 URL 由 PageSite 自己算（见它的 buildStartUrl）：本类不再掺和站点的事——
	// 它要知道的只有 type 与配置，而那两样它都能从本窗口读到
	page = std::make_unique<PageSite>(this, webview);
	return S_OK;
}

void WindowSite::onDestroy()
{
	windowsSite.erase(hwnd);
	// 不触发 PostQuitMessage：site 窗口关闭不影响主进程，主进程退出由主 Window::onDestroy 触发
}