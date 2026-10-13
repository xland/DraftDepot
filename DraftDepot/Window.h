#pragma once
#include "Env.h"

class Page;
class Window
{
public:
	/// 析构必须在 cpp 里定义：成员 page 是 unique_ptr<Page>，而这里 Page 只有前置声明，
	/// 析构得在 Page 完整可见的地方实例化
	~Window();
	static Window* create();
	void show();
	/// 自绘标题栏拖动：val 是 HT_* 命中值，直接落成 WM_NCLBUTTONDOWN
	void hittest(int val);
	void minimize();
	void maximize();
	void restore();
public:
	HWND hwnd;
private:
	static LRESULT CALLBACK winMsg(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam);
	void createWin();
	HRESULT onCtrlReady(HRESULT result, ICoreWebView2Controller* ctrl);
	void onSize(WPARAM wParam, LPARAM lParam);
	void onDestroy();
	void onGetMinMaxInfo(MINMAXINFO* mmi);
	/** 默认窗口矩形：DEFAULT_WIDTH x DEFAULT_HEIGHT，摆在主显示器工作区正中。
	    建窗、"从最大化还原"都用它，两处的默认大小因此永远同步 */
	RECT defaultRect() const;
private:
	/// 默认窗口尺寸（含边框），改默认大小只动这里
	static constexpr int DEFAULT_WIDTH = 1600;
	static constexpr int DEFAULT_HEIGHT = 1200;
	std::unique_ptr<Page> page;
	ComPtr<ICoreWebView2Controller> ctrl;
};