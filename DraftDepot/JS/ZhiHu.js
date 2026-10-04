// 由 PageSite::injectSiteScript 注入到 zhuanlan.zhihu.com，每个文档（含跳转后）都会跑一遍。
// 注入时前面拼了 Msg.js（window.DDMsg，跟 native 说话）与 Content.js（window.DDContent，
// 收拾正文形态的共用工具），所以站点脚本里直接用它们，不用各自再写一遍 IPC 与语言判定。
// 职责：
//   1. 把原始正文收拾成知乎编辑器认的那一版（见文末的 forZhiHu）：只是给代码块标语言，其余原样、
//      样式一样也不加——它的编辑页是 Draft.js，HTML 进去还要过它自己的处理器重排；
//   2. 进了文章编辑页就把收拾好的正文（连同标题）灌进知乎编辑器。
//
// 登录这件事不用脚本操心：没登录时打开 /write 会被知乎自动送到登录页，登录成功后又被自动送回
// /write ——那是另一次导航、另一个文档，本脚本会重新跑一遍。所以这里只认编辑页、只干灌入。
//
// 图片是唯一要额外跑一趟的事：正文里的图是 https://app.localhost/images/<文件名>（本程序 WebView2
// 的虚拟映射，知乎服务器取不到），得按文件名从本机图片目录取文件、传它的图床，拿到地址换掉正文里的
// src 再灌进去。取文件 + 传图床 + 换地址这套四个站点一模一样，收在 Images.js 里共用一份
// （DDImages.uploadImages），这里只留知乎自己的上传接口 uploadImage。
// 目录句柄只能由 native 给：脚本跑在网页上下文里，碰不到本机文件系统，光有路径也造不出 File 对象。
// 传过的图不再重复传：地址记在 image_site 表里，下次直接取（见 Images.js 的 imageUrl）。

// 文章编辑页：新草稿是 /write；知乎给草稿存盘后会把地址改成 /p/<id>/edit，两个都得认。
// 认这两个而不是"只要 hostname 是 zhuanlan 就干"，是为了避开文章页底下的评论框——它也是 DraftEditor
const EDIT_PAGE = /^\/(write|p\/\d+\/edit)$/;

/** 图片上传接口：知乎自己的图床，带 cookie（withCredentials）才有身份，所以只能在这个页面里发 */
const UPLOAD_IMAGE_URL = "https://zhuanlan.zhihu.com/api/uploaded_images";

const CHECK_INTERVAL = 600;

let filled = false; // 本文档已经灌过一轮：页面自身的后续刷新不该再糊一遍

/** 正文编辑器：知乎用的是 Draft.js，.DraftEditor-root 底下那块 contenteditable */
function getEditor() {
  return [...document.querySelectorAll('[contenteditable="true"]')].find((el) =>
    el.closest(".DraftEditor-root"),
  );
}

/**
 * 标题输入框：<textarea placeholder="请输入标题（最多 100 个字）">。
 * 它的 class 里带着 i7cW1UcwT6ThdhTakqFm 这种构建哈希，改版就变，只能拿 placeholder 认
 */
function getTitleInput() {
  return document.querySelector('textarea[placeholder*="请输入标题"]');
}

/**
 * 标题：React 受控组件，直接写 input.value 它收不到（自己缓存的值会在下次渲染时把改动冲掉），
 * 得走原型上的原生 setter 改完再派发 input 事件，React 才会当成"用户敲进去的"更新 state
 */
function setTitle(input, text) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  setter.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * 正文：往 contenteditable 上派发一次带 clipboardData 的 paste，整篇替换掉原有内容。
 * 这条路跟人在编辑器里 Ctrl+V 走的是同一套处理（Draft.js 的 onPaste），格式才留得住——
 * 知乎自己的粘贴处理器会把 HTML 规范化成它认的样式，图片也由它走上传转存，
 * 比我们绕开它自己造 EditorState 稳得多（Draft.js 是受控组件，见文件末尾的说明）。
 *
 * "替换"由选区实现：focus 后 selectAllChildren 全选就**不再** collapseToEnd——
 * Draft.js 处理 paste 时见选区没折叠，会先 removeRange 再 insertFragment，正好就是整篇替换。
 * 不用 selectAllChildren + deleteFromDocument 先清空：整块删会让它的 DOM 观察器跟
 * editorState 走到不同步，随后的 paste 就落错地方了
 */
function setContent(editor, html) {
  editor.focus();
  const sel = window.getSelection();
  sel.selectAllChildren(editor);
  const dt = new DataTransfer();
  dt.setData("text/html", html);
  const ev = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", { value: dt });
  editor.dispatchEvent(ev);
}

/** 上传一张图，拿到它的图床地址（返回 JSON 里的 src）；取文件与"传过没有"由 Images.js 管 */
function uploadImage(file) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("picture", file);
    form.append("source", "article");
    const xhr = new XMLHttpRequest();
    xhr.open("POST", UPLOAD_IMAGE_URL, true);
    xhr.withCredentials = true; // 身份在 cookie 里，不带就验不过
    xhr.setRequestHeader("X-Requested-With", "Fetch");
    xhr.setRequestHeader("accept", "application/json, text/plain, */*");
    xhr.onreadystatechange = () => {
      if (xhr.readyState !== 4) return;
      if (xhr.status !== 200 && xhr.status !== 304) {
        reject(new Error("上传图片失败，HTTP " + xhr.status));
        return;
      }
      const src = JSON.parse(xhr.responseText).src;
      if (!src) reject(new Error("上传图片没返回地址"));
      else resolve(src);
    };
    xhr.send(form);
  });
}

// —— 正文形态适配 ——
// 主编辑器给过来的是编辑器里的原始正文（roosterjs 的产物，代码块是 <pre><code data-lang="x">纯文本</code></pre>），
// 这里只做一件事：给代码块标语言。
//   data-lang 是我们自己的标记，知乎不认；它按 Prism 的类名认语言，所以补一个 language-* 上去，
//   data-lang 随后去掉——这份 HTML 是给知乎的，留着我们的自定义属性没有用处。
//   认不出语言的代码块原样留着（知乎会当成没标语言的代码块）。
//
// 样式一概不碰：知乎的编辑器是 Draft.js（受控组件），粘贴过来的 HTML 先过它自己的处理器——<pre> 被收成
// 它的代码块 block、只留纯文本，随后由它的 Prism 重新着色，我们自己塞的底色与内联色一个不剩；提交时
// 服务端还会再清洗一遍，编辑期侥幸留在 DOM 上的样式同样留不到最终页面。
// 结论：这条链路能带过去的只有"它的语义结构"（p / h2 / blockquote / ul / b / 代码块…），没有自定义 CSS，
// 着色与排版交给它。微信那条链路正好相反——它不吃 class 只吃内联 style，见 JS/WeiXin.js。

/** 原始正文 → 知乎编辑器认的那一版（只给代码块标语言） */
function forZhiHu(html) {
  const root = DDContent.parse(html);
  DDContent.eachCode(root, function (codeEl, lang) {
    codeEl.classList.add("language-" + lang);
    codeEl.removeAttribute("data-lang");
  });
  return root.innerHTML;
}

const timer = setInterval(async () => {
  // 只在顶层文档干活：注入脚本每个 iframe 也会跑一遍，别钻到别人的框里去做判断
  if (window.self !== window.top) return;
  if (!EDIT_PAGE.test(location.pathname)) return; // 登录页 / 别的页面：等它自己跳回编辑页

  // 编辑页是 SPA：地址先落到，编辑器随后才初始化完，所以要盯着等
  const editor = getEditor();
  if (!editor) return;
  // 不设等待超时：从登录页到人输完验证码可能要好几分钟，超时放弃就等于白跑一趟。
  // 反复等没有副作用——灌入由 filled 挡着，每个文档最多灌一次
  clearInterval(timer);

  if (filled) return;
  filled = true;
  const article = await DDMsg.invoke("getArticle");
  // 两份都空 = 这一轮早给过了（页面刷新/跳转会让本脚本整个重跑），或这篇本来就没内容：都别动手
  if (!article || (!article.title && !article.html)) return;

  // 传图 + 灌标题正文这一整段都盖着遮罩：那期间页面是半截的，别让人插手（见 Mask.js）
  await DDMask.withMask(async () => {
    const titleInput = getTitleInput();
    if (article.title && titleInput) setTitle(titleInput, article.title);
    // 先收拾形态：代码块标上语言（见 forZhiHu）；图再换成图床地址（传过的直接取旧地址，见 Msg.js），
    // 最后整篇灌进去——之后就全是知乎自己的事了，着色与排版由它的 Prism 重做
    if (article.html) setContent(editor, await DDImages.uploadImages(forZhiHu(article.html), uploadImage));
  });
  console.log("[DraftDepot] 文章已灌入知乎编辑器");
}, CHECK_INTERVAL);

// 为什么不直接调 Draft.js 的 API 写内容（像微信那样走 __MP_Editor_JSAPI__）：
// Draft.js 是**受控组件**，改内容的唯一途径是给 <Editor> 传一个新的 EditorState，
// 而这个 state 与 onChange 都在知乎自己 bundle 的 React state 里，window 上没有任何入口
// （微信那种 JSAPI 是它自己挂出来的，知乎没这东西）。
// 硬要走这条路只能从 DOM 上的 React fiber（__reactFiber$xxx）逆推出 editorState 与 onChange，
// 可构造新 EditorState 还得拿到 Draft 内部的 convertFromHTML / ContentBlock / CharacterMetadata
// ——这些模块也都在打包产物里，只能从已有实例的 constructor 反推，改个版就崩。
// 而且绕开它的粘贴处理器意味着样式与图片都得我们自己收拾（图片还得走它的上传接口才能转存），
// 远不如让它自己处理一次 paste。
