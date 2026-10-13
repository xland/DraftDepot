#include "Env.h"
#include <dwmapi.h>
#include "Window.h"
#include "Page.h"
#include "Util.h"

std::unordered_map<HWND, std::unique_ptr<Window>> windows;
// 见 Window.h 的说明：unique_ptr<Page> 的析构要实例化在 Page 完整可见的本文件
Window::~Window()
{
}

Window* Window::create()
{
    auto win = std::make_unique<Window>();
    win->createWin();
    auto result = win.get();
    windows.insert({ win->hwnd ,std::move(win) });
    return result;
}
LRESULT Window::winMsg(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    auto self = reinterpret_cast<Window*>(GetWindowLongPtr(hwnd, GWLP_USERDATA));
    if (!self) return DefWindowProc(hwnd, msg, wParam, lParam);
    if (msg == WM_SIZE) {
        self->onSize(wParam, lParam);
    }
    else if (msg == WM_DESTROY) {
        self->onDestroy();
    }
    else if (msg == WM_GETMINMAXINFO) {
        self->onGetMinMaxInfo((PMINMAXINFO)lParam);
    }
    return DefWindowProc(hwnd, msg, wParam, lParam);
}

void Window::createWin()
{
    WNDCLASSEXW wcex;
    wcex.cbSize = sizeof(WNDCLASSEX);
    wcex.style = CS_HREDRAW | CS_VREDRAW;
    wcex.lpfnWndProc = &Window::winMsg;
    wcex.cbClsExtra = 0;
    wcex.cbWndExtra = 0;
    wcex.hInstance = GetModuleHandle(nullptr);
    // 与 site 窗口同一个 logo：标题栏左侧挂小图标、任务栏与 Alt+Tab 挂大图标，
    // 都按系统各自的图标尺寸从 ico 里取帧（ico 有多帧时才挑得到清晰的那一帧）
    wcex.hIcon = (HICON)LoadImage(wcex.hInstance, MAKEINTRESOURCE(Util::appIconId), IMAGE_ICON,
        GetSystemMetrics(SM_CXICON), GetSystemMetrics(SM_CYICON), LR_DEFAULTCOLOR);
    wcex.hIconSm = (HICON)LoadImage(wcex.hInstance, MAKEINTRESOURCE(Util::appIconId), IMAGE_ICON,
        GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), LR_DEFAULTCOLOR);
    wcex.hCursor = LoadCursor(nullptr, IDC_ARROW);
    wcex.hbrBackground = (HBRUSH)COLOR_WINDOW;
    wcex.lpszMenuName = nullptr;
    wcex.lpszClassName = L"DraftDepot";
    RegisterClassEx(&wcex);
    // 初始位置/大小统一由 defaultRect() 给（原来是写死的 200,300,1000,800）
    auto rect = defaultRect();
    hwnd = CreateWindowEx(WS_EX_APPWINDOW, wcex.lpszClassName, wcex.lpszClassName, WS_MAXIMIZEBOX | WS_MINIMIZEBOX | WS_POPUP, rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top, nullptr, nullptr, wcex.hInstance, nullptr);
    SetWindowLongPtr(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(this));
    MARGINS margins = { 1, 1, 1, 1 };
    DwmExtendFrameIntoClientArea(hwnd, &margins);
    int value = 2;
    DwmSetWindowAttribute(hwnd, DWMWA_NCRENDERING_POLICY, &value, sizeof(value));
    DwmSetWindowAttribute(hwnd, DWMWA_ALLOW_NCPAINT, &value, sizeof(value));

    auto wvEnv = Env::getWebViewEnv();
    auto ctrlReadyCB = Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(this, &Window::onCtrlReady);
    wvEnv->CreateCoreWebView2Controller(hwnd, ctrlReadyCB.Get());
}

void Window::show()
{
    ShowWindow(hwnd, SW_SHOWMAXIMIZED);
    ctrl->put_IsVisible(TRUE);
}

void Window::hittest(int val)
{
    ReleaseCapture();
    PostMessage(hwnd, WM_NCLBUTTONDOWN, val, 0);
}
void Window::minimize()
{
    ctrl->NotifyParentWindowPositionChanged();
    HWND hwndWebView = FindWindowEx(hwnd, nullptr, L"Chrome_WidgetWin_0", nullptr);
    PostMessage(hwndWebView, WM_MOUSELEAVE, 0, 0);
    HWND hwndInner = FindWindowEx(hwndWebView, nullptr, NULL, nullptr);
    PostMessage(hwndInner, WM_MOUSELEAVE, 0, 0);
    ShowWindow(hwnd, SW_MINIMIZE);
}
void Window::maximize()
{
    ShowWindow(hwnd, SW_MAXIMIZE);
}

void Window::restore()
{
    // 只在真正从最大化下来时复位尺寸：从最小化还原（任务栏点回来）应该保持原样
    const auto wasMaximized = IsZoomed(hwnd);
    ShowWindow(hwnd, SW_RESTORE);
    if (!wasMaximized) return;
    // SW_RESTORE 回到的是"进最大化之前"那套坐标：那是用户拖边框拖出来的尺寸，不是默认大小。
    // 所以还原之后再按默认矩形显式摆一次。
    // NOZORDER | NOACTIVATE：只动位置和大小，不动 Z 序、不抢焦点；随后 WM_SIZE 会同步 webview 的 bounds
    auto rect = defaultRect();
    SetWindowPos(hwnd, nullptr, rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top, SWP_NOZORDER | SWP_NOACTIVATE);
}
RECT Window::defaultRect() const
{
    RECT workAreaRect;
    SystemParametersInfo(SPI_GETWORKAREA, 0, &workAreaRect, 0);
    const auto workWidth = workAreaRect.right - workAreaRect.left;
    const auto workHeight = workAreaRect.bottom - workAreaRect.top;
    // 夹在工作区内：小分辨率显示器上不会被裁成默认大小溢出屏幕
    const auto width = DEFAULT_WIDTH < workWidth ? DEFAULT_WIDTH : workWidth;
    const auto height = DEFAULT_HEIGHT < workHeight ? DEFAULT_HEIGHT : workHeight;
    const auto left = workAreaRect.left + (workWidth - width) / 2;
    const auto top = workAreaRect.top + (workHeight - height) / 2;
    return { left, top, left + width, top + height };
}

HRESULT Window::onCtrlReady(HRESULT result, ICoreWebView2Controller* ctrl)
{
    this->ctrl = ctrl;
    ComPtr<ICoreWebView2> webview;
    ctrl->get_CoreWebView2(&webview);
    RECT bounds;
    GetClientRect(hwnd, &bounds);
    ctrl->put_Bounds(bounds);
    page = std::make_unique<Page>(this, webview);
    return S_OK;
}
void Window::onSize(WPARAM wParam, LPARAM lParam)
{
    if (!ctrl.Get()) return;
    if (wParam == SIZE_MAXIMIZED) {
        JsonObject jsonObj;
        jsonObj.SetNamedValue(L"eventName", JsonValue::CreateStringValue(L"maximize"));
        page->emit(jsonObj);
    }
    else if (wParam == SIZE_RESTORED) {
        JsonObject jsonObj;
        jsonObj.SetNamedValue(L"eventName", JsonValue::CreateStringValue(L"restore"));
        page->emit(jsonObj);
    }
    RECT bounds = { 0, 0, LOWORD(lParam), HIWORD(lParam) };
    ctrl->put_Bounds(bounds);
}
void Window::onDestroy()
{
    windows.erase(hwnd);
    if (windows.empty()) {
        PostQuitMessage(0);
    }
}

void Window::onGetMinMaxInfo(MINMAXINFO* mmi)
{
    RECT workAreaRect;
    BOOL getWorkAreaSuccess = SystemParametersInfo(SPI_GETWORKAREA, 0, &workAreaRect, 0);
    mmi->ptMaxPosition.x = workAreaRect.left;
    mmi->ptMaxPosition.y = workAreaRect.top;
    mmi->ptMaxSize.x = workAreaRect.right - workAreaRect.left;
    mmi->ptMaxSize.y = workAreaRect.bottom - workAreaRect.top;
    mmi->ptMinTrackSize.x = 500;
    mmi->ptMinTrackSize.y = 388;
}

