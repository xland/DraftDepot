#pragma once
#include "Env.h"

class WindowSite;

/**
 * site 窗口的 webview 页面层（与 Page 类平行，不继承）。
 *   - 不劫持本地资源（不注册 WebResourceRequested filter），让 webview 走网络正常加载；
 *   - 注册 WebMessageReceived 处理站点脚本调 native；
 *   - 注册 WindowCloseRequested 转发 WM_CLOSE 关窗；
 *   - 注册 DocumentTitleChanged，把网页标题同步到窗口标题栏（窗口图标仍是我们自己的，不跟网页走）。
 * 不做主动脚本注入：站点脚本只填site 页面用到的那部分。
 *
 * "这个站点是什么样"——开哪个页面、注入哪份脚本——都收在这里（见本文件顶部的 siteHome 与
 * buildStartUrl）：两边用的是同一个 type，摆在一起才不会登记了一边忘了另一边。
 */
class PageSite
{
public:
	PageSite(WindowSite* win, ComPtr<ICoreWebView2>& webview);
	~PageSite();
private:
	HRESULT onMsgReceived(ICoreWebView2* webview, ICoreWebView2WebMessageReceivedEventArgs* args);
	HRESULT onCloseWindow(ICoreWebView2* sender, IUnknown* args);
	HRESULT onTitleChange(ICoreWebView2* sender, IUnknown* args);
	/**
	 * 按窗口 type 算出起始 URL：微信有 token 就直接进新建图文的编辑页（顺带拼一个毫秒时间戳，
	 * 免得拿到缓存页），没有就落它的首页等用户登录；其他平台用 siteHome 里各自登记的落地页。
	 * 没登记过的 type 返回空串（调用方拿到空串不导航）
	 */
	std::wstring buildStartUrl();
	/// 注入站点脚本：把 Msg.js（DDMsg 这个 IPC 客户端）与按窗口 type 取到的同名脚本
	/// （type "WeiXin" → WeiXin.js）拼在一起注册；必须在 Navigate 之前调，否则首屏文档赶不上
	void injectSiteScript(ComPtr<ICoreWebView2>& webview);
	/// args: { text, url? }；站点脚本碰上"没法往下走"的情况时弹一句话告诉用户怎么办
	/// （如博客园的默认编辑器不是 Editor.md，得先去偏好设置里改）。
	/// 弹框 → 用户点确定 → 有 url 就用系统默认浏览器打开它 → 关掉本窗口。
	/// 三步都由 native 做：对话框风格跟程序一致，打开默认浏览器与关窗更是网页里够不着的事
	void handleNotice(JsonObject& param, JsonObject& result);
	/// args: 无；站点脚本（如 ZhiHu.js）往对方图床传正文里的图之前，向 native 要图片目录的句柄，
	/// 拿到目录后自己 getFileHandle 取文件，不用再为每张图往返一次。
	/// 只能由 native 给：脚本跑在网页上下文里，碰不到本机文件系统，光有路径也造不出 File 对象。
	/// 与主窗口的 Page::handleGetImageDir 是同一个目录，但只给 READ——站点只传图，不写图
	void handleGetImageDir(JsonObject& result);
	/// args: { url?, name?, names? }；站点脚本要读自己站点的 cookie——有些 cookie 是 HttpOnly，
	/// document.cookie 根本读不到（微信用 ticket_id 验上传身份，就属于这种），只能由 native 代读。
	/// 做成通用的：url 不给就取本窗口打开的那个地址，name / names 不给就把这个源下的 cookie 全给，
	/// 将来别的站点要读自己的 cookie 直接用同一条消息。
	/// 回包是异步的：CookieManager 的取 cookie 是回调式的，所以不在调用处回，在回调里发
	void handleGetCookie(JsonObject& param, JsonObject& result);
	/// args: { name }；站点脚本传图前先问这张图在本站点传过没有——传过就直接拿地址（省一趟上传，
	/// 也免得对方图床堆重复副本），没传过给空 url。站点名取窗口 type，不由脚本传，免得写错
	void handleGetImageUrl(JsonObject& param, JsonObject& result);
	/// args: { name, url }；传成功后把地址交给 native 记下来（按"图片文件 + 站点"记一条，
	/// 见 Db::createSchema 里的 image_site），下次发布由 handleGetImageUrl 直接取
	void handleSetImageUrl(JsonObject& param, JsonObject& result);
private:
	WindowSite* win;
	ComPtr<ICoreWebView2> webview;
	/// 开窗时导航进去的那个地址（见 buildStartUrl）。页面之后跳到哪儿它不跟着变，
	/// 只在这里当"本窗口打开的是哪个站点"用：站点脚本不给 url 取 cookie 时，取的就是它
	std::wstring startUrl;
};