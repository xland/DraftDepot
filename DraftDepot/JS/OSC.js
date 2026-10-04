// 由 PageSite::injectSiteScript 注入到 my.oschina.net，每个文档（含跳转后）都会跑一遍。
// 注入时前面拼了 Msg.js，所以直接用它挂的 window.DDMsg 跟 native 说话。
// 职责：进了写作页就把"待发布的文章"（点发布按钮时由主编辑器交给 native 的）灌进 OSC 编辑器。
// 与知乎/CSDN 同一套：正文在前端已经转成 Markdown（见 UI/src/EditorContent/Markdown.ts），
// 这里只管把它写进编辑器，不做任何格式加工。
//
// 登录这件事不用脚本操心：没登录时打开写作页会被 OSC 送到登录页，登录成功后又被自动送回写作页
// ——那是另一次导航、另一个文档，本脚本会重新跑一遍。所以等编辑器就绪不设超时：
// 从登录页到人输完验证码可能要好几分钟，超时放弃就等于白跑一趟。
//
// 图片是唯一要额外跑一趟的事：正文里的图是 https://app.localhost/images/<文件名>（本程序 WebView2
// 的虚拟映射，OSC 的服务器取不到），得按文件名从本机图片目录取文件、传它的图床，拿到地址换掉
// Markdown 里的图片地址再灌进去。取文件、传图床、换地址这套全由 Images.js 管（DDImages.uploadMarkdownImages），
// 这里只留 OSC 自己的上传接口 uploadImage。目录句柄只能由 native 给：脚本跑在网页上下文里，
// 碰不到本机文件系统，光有路径也造不出 File 对象。

// 写作页。只认路径结尾，不认 /u/<账号 id> ——换账号登录、或被送回时带的 query 变了都还能认出来
const EDIT_PAGE_SUFFIX = "/blog/ai-write";

/** 图片上传接口：OSC 自己的图床（AI 创作这条线的），身份在 cookie 里，带 withCredentials 才验得过 */
const UPLOAD_IMAGE_URL = "https://apiv1.oschina.net/oschinapi/ai/creation/project/uploadDetail";

const CHECK_INTERVAL = 600;

let filled = false; // 本文档已经灌过一轮：页面自身的后续刷新不该再糊一遍

/** 正文编辑器：OSC 是 Markdown 编辑器，正文就落在一个 textarea 上 */
function getContentBox() {
  return document.querySelector("textarea");
}

/** 标题输入框：写作页上第一个 input */
function getTitleInput() {
  return document.querySelector("input");
}

/**
 * 赋值：走原型上的原生 setter，再派发一次 input 事件。
 * 页面是 Vue（v-model 绑在 value 上）：Vue 把实例上的 value 改写成自己的，直接 el.value = x
 * 只是改了 DOM 属性，它内部那个变量还是旧值，下一轮渲染就把改动冲掉了；只有
 * HTMLTextAreaElement / HTMLInputElement 原型上的原生 setter 能真正写进去，补一个 input 事件
 * 它才会当成"用户敲进去的"收进 model（顺带刷新预览）
 */
function setValue(el, text) {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * 上传一张图，拿到它的图床地址。
 * 表单就一个 file 字段（二进制）；返回 JSON 的 result 是地址（success 为 true 才算成）。
 * 接口在 apiv1.oschina.net，与页面（my.oschina.net）不同源，靠它自己的 CORS 头放行；
 * 没登录或 CORS 不给过时会 reject，地址留空——正文里那张图就是个死链，但不拦别的
 */
function uploadImage(file) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
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
      if (!data.success || !data.result) reject(new Error("上传图片没返回地址"));
      else resolve(data.result);
    };
    xhr.send(form);
  });
}

const timer = setInterval(async () => {
  // 只在顶层文档干活：注入脚本每个 iframe 也会跑一遍，别钻到别人的框里去做判断
  if (window.self !== window.top) return;
  if (!location.pathname.endsWith(EDIT_PAGE_SUFFIX)) return; // 登录页 / 别的页面：等它自己跳回写作页

  // 写作页是 SPA：地址先落到，编辑器随后才渲染出来
  const contentBox = getContentBox();
  const titleInput = getTitleInput();
  if (!contentBox || !titleInput) return;
  clearInterval(timer);

  if (filled) return;
  filled = true;
  const article = await DDMsg.invoke("getArticle");
  // 两份都空 = 这一轮早给过了（页面刷新/跳转会让本脚本整个重跑），或这篇本来就没内容：都别动手
  if (!article || (!article.title && !article.html)) return;

  // 传图 + 灌标题正文这一整段都盖着遮罩：那期间页面是半截的，别让人插手（见 Mask.js）
  await DDMask.withMask(async () => {
    if (article.title) setValue(titleInput, article.title);
    // 图先传上去换成图床地址，再把 Markdown 写进编辑器（见文件头说明）
    if (article.html) setValue(contentBox, await DDImages.uploadMarkdownImages(article.html, uploadImage));
  });
  console.log("[DraftDepot] 文章已灌入 OSC 编辑器");
}, CHECK_INTERVAL);
