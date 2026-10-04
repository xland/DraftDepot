// 由 PageSite::injectSiteScript 注入到 i.cnblogs.com，每个文档（含跳转后）都会跑一遍。
// 注入时前面拼了 Msg.js，所以直接用它挂的 window.DDMsg 跟 native 说话。
// 职责：进了文章编辑页（https://i.cnblogs.com/posts/edit，编辑器要在 Markdown 模式）就把
// "待发布的文章"（点发布按钮时由主编辑器交给 native 的）灌进博客园编辑器。
// 与开源中国同一套：正文在前端已经转成 Markdown（见 UI/src/EditorContent/Markdown.ts），
// 这里只管把它写进 CodeMirror，不做任何格式加工。
//
// 登录这件事不用脚本操心：没登录时打开 /posts/edit 会被博客园送到登录页，登录成功后又被自动送回
// ——那是另一次导航、另一个文档，本脚本会重新跑一遍。所以等"编辑页出现"不设超时：
// 从登录页到人输完验证码可能要好几分钟，超时放弃就等于白跑一趟。
// 唯一的例外是下面 NO_EDITOR_TIMEOUT 那一段：编辑页确实渲染出来了，但编辑器不是 Editor.md。
//
// 图片是唯一要额外跑一趟的事：正文里的图是 https://app.localhost/images/<文件名>（本程序 WebView2
// 的虚拟映射，博客园的服务器取不到），得按文件名从本机图片目录取文件、传它的图床，拿到地址换掉
// Markdown 里的图片地址再灌进去。取文件、传图床、换地址这套全由 Images.js 管（DDImages.uploadMarkdownImages），
// 这里只留博客园自己的上传接口 uploadImage。目录句柄只能由 native 给：脚本跑在网页上下文里，
// 碰不到本机文件系统，光有路径也造不出 File 对象。

// 文章编辑页：认这一个，而不是"只要 hostname 是 i.cnblogs.com 就干"，
// 免得在后台的其它页面（随笔列表、设置）上乱找编辑器
const EDIT_PAGE = "/posts/edit";

const CHECK_INTERVAL = 600;

/** 博客园的偏好设置页：默认编辑器在这儿改（发现编辑器不是 Editor.md 时把人送过去） */
const PREFERENCE_URL = "https://i.cnblogs.com/preference";

/**
 * 编辑页已渲染却迟迟不见 CodeMirror，就认定默认编辑器不是 Editor.md（页面停在富文本模式）：
 * 那等下去也不会有。给 3 秒：editor.md 的初始化就在那一两拍里，等久了只让人干看着
 */
const NO_EDITOR_TIMEOUT = 3000;

let waited = 0; // 编辑页已就绪但 CodeMirror 还没出来的累计等待毫秒数

/**
 * 正文编辑器：Markdown 模式用的是 editor.md，正文在 CodeMirror 里。
 * CodeMirror 初始化时会把实例挂在它那个 textarea 的下一个兄弟节点上
 * （.editormd-markdown-textarea 是 editor.md 给这个 textarea 加的 class）
 */
function getCodeMirror() {
  const textarea = document.querySelector(".editormd-markdown-textarea");
  return textarea && textarea.nextSibling ? textarea.nextSibling.CodeMirror : null;
}

/** 标题输入框：#post-title（Markdown 模式与富文本模式共用这一个） */
function getTitleInput() {
  return document.getElementById("post-title");
}

/**
 * 写标题：走 input 原型上那个原生 value setter，再派一次 input 事件。
 * 不能直接赋 value：这个输入框被页面自己的框架（Vue）接管，框架只认它监听到的 input 事件，
 * 值改了而框架不知道，点发布时它拿到的仍是空标题，就报"请输入文章标题"。
 * 走原型上的 setter 而不是 input.value = x，是因为框架可能把实例上的 value 覆写成了访问器，
 * 直接赋值会进它的 setter 而绕不过去
 */
function setTitle(input, text) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** 图床上传接口：upload.cnblogs.com（与页面所在的 i.cnblogs.com 是 same-site，靠它自己的 CORS 头放行） */
const UPLOAD_IMAGE_URL = "https://upload.cnblogs.com/v2/images/cors-upload";

/**
 * 上传一张图，拿到它的图床地址。
 * 表单三个字段：image 是文件本身（二进制），app=blog 与 uploadType=Select 是它固定的两个附加字段。
 * 身份在 cookie 里，带 withCredentials 才验得过；返回 JSON 的 imageUrl 是地址（有它才算成）。
 * 没登录或 CORS 不给过时会 reject，地址留空——正文里那张图就是个死链，但不拦别的
 */
function uploadImage(file) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("image", file);
    form.append("app", "blog");
    form.append("uploadType", "Select");
    const xhr = new XMLHttpRequest();
    xhr.open("POST", UPLOAD_IMAGE_URL, true);
    xhr.withCredentials = true; // 身份在 cookie 里，不带就验不过
    xhr.onreadystatechange = () => {
      if (xhr.readyState !== 4) return;
      if (xhr.status !== 200 && xhr.status !== 304) {
        reject(new Error("上传图片失败，HTTP " + xhr.status));
        return;
      }
      const data = JSON.parse(xhr.responseText);
      if (!data.imageUrl) reject(new Error("上传图片没返回地址"));
      else resolve(data.imageUrl);
    };
    xhr.send(form);
  });
}

const timer = setInterval(async () => {
  // 只在顶层文档干活：注入脚本每个 iframe 也会跑一遍，别钻到别人的框里去做判断
  if (window.self !== window.top) return;
  if (location.pathname !== EDIT_PAGE) return; // 登录页 / 别的页面：等它自己跳回编辑页

  // 编辑页是 SPA：地址先落到，标题框与 editor.md 随后才渲染出来
  const cm = getCodeMirror();
  const titleInput = getTitleInput();
  // 连标题框都还没有 = 页面还没渲染完：这一拍不算数，继续等
  if (!titleInput) return;

  // 页面就绪却没有 CodeMirror：多半停在富文本模式。攒够时间就提醒，不再干等
  if (!cm) {
    waited += CHECK_INTERVAL;
    if (waited < NO_EDITOR_TIMEOUT) return;
    clearInterval(timer);
    // 弹框提醒 → 点确定 → 系统默认浏览器打开偏好设置 → 关掉本窗口
    // （三步都由 native 做，见 PageSite::handleNotice）
    await DDMsg.invoke("notice", {
      text: "请把博客园默认编辑器设置为：Editor.md",
      url: PREFERENCE_URL,
    });
    return;
  }

  clearInterval(timer); // 取到就停表：一个文档只灌一次

  const article = await DDMsg.invoke("getArticle");
  // 两份都空 = 这一轮早给过了（页面刷新/跳转会让本脚本整个重跑），或这篇本来就没内容：都别动手
  if (!article || (!article.title && !article.html)) return;

  // 灌标题正文这一整段都盖着遮罩：那期间页面是半截的，别让人插手（见 Mask.js）
  await DDMask.withMask(async () => {
    if (article.title) setTitle(titleInput, article.title);
    // 字段叫 html，这一趟装的其实是 Markdown（见文件头）：图先传上去换成图床地址再灌进去
    // （见文件头说明），CodeMirror 自己的 setValue 会顺带刷新预览
    if (article.html) cm.setValue(await DDImages.uploadMarkdownImages(article.html, uploadImage));
  });
  console.log("[DraftDepot] 文章已灌入博客园编辑器");
}, CHECK_INTERVAL);
