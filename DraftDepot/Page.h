#pragma once
#include "Env.h"

class Window;

class Page
{
public:
	Page(Window* win, const ComPtr<ICoreWebView2>& webview);
	void emit(const JsonObject& eventData);
private:
	HRESULT onRequest(ICoreWebView2* webview, ICoreWebView2WebResourceRequestedEventArgs* args);
	HRESULT onMsgReceived(ICoreWebView2* webview, ICoreWebView2WebMessageReceivedEventArgs* args);
	HRESULT onDomLoaded(ICoreWebView2* sender, ICoreWebView2DOMContentLoadedEventArgs* args);
	HRESULT onRequestPermission(ICoreWebView2* webview, ICoreWebView2PermissionRequestedEventArgs* args);
	HRESULT onCloseWindow(ICoreWebView2* sender, IUnknown* args);
	std::wstring getContentType(const std::wstring& fileName);
	HRESULT serveFileFromDataPath(ICoreWebView2WebResourceRequestedEventArgs* args, const std::wstring& resName);
	void handleGetImageDir(const JsonObject& result);
private:
	Window* win;
	ComPtr<ICoreWebView2> webview;
};

