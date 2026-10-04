// 由 PageSite::injectSiteScript 注入到 mp.weixin.qq.com，每个文档（含跳转后）都会跑一遍。
// 注入时前面拼了 Msg.js（window.DDMsg，跟 native 说话）与 Content.js（window.DDContent，
// 收拾正文形态的共用工具），所以站点脚本里直接用它们，不用各自再写一遍 IPC 与语言判定。
// 职责：
//   1. 盯住登录态与 token——失效就回登录页，拿到 token 就回传 C++ 存库，并直奔新建图文的编辑页；
//   2. 把原始正文收拾成微信编辑器认的那一版（见文末的 forWeiXin），再把标题正文一起灌进去。
//      代码块换 code-snippet 组件那一步还没搬过来——它要用 shiki 着色，注入脚本是资源里的裸 JS，
//      拿不到着色器，暂时留在 UI/src/EditorContent/WeiXinHtml.ts，见那个文件的说明；
//   3. 灌完记一个"已发过"的标志（在 native 的发布窗口上）：微信发布成功后会自己跳回首页，
//      本脚本在每个文档里都要重跑一遍，靠这个标志认出"这是发完之后的跳转"，不再把人拽回编辑页。
//
// 图片是唯一要额外跑一趟的事：正文里的图是 https://app.localhost/images/<文件名>（本程序 WebView2
// 的虚拟映射，微信的服务器取不到）。早先的做法是在主编辑器那边就把图读成 base64 内联进 <img src>，
// 现在改成跟知乎/CSDN 同一套：按文件名从本机图片目录取文件，走它自己的素材上传接口传到图床，
// 拿到 cdn_url 换掉正文里的 src 再灌进去。取文件 + 传图床 + 换地址这套四个站点一模一样，收在
// Images.js 里共用一份（DDImages.uploadImages），这里只留微信自己的上传接口 uploadImage。
// 目录句柄只能由 native 给：脚本跑在网页上下文里，碰不到本机文件系统，光有路径也造不出 File 对象。
// 传过的图不再重复传：地址记在 image_site 表里，下次直接取（见 Images.js 的 imageUrl）。
//
// 上传接口要的身份参数比别家多：token（地址上有）、ticket 与 svr_time（页面全局变量 wx.* 上有），
// 再加 cookie 里的 ticket_id —— 它是 HttpOnly，document.cookie 读不到，只能问 native 要
// （DDMsg.invoke("getCookie")，见 PageSite::handleGetCookie）。

// 新建图文的编辑页：拿到 token 后拼这个地址
const CREATE_ARTICLE_URL =
  "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77&createType=0&token={token}&lang=zh_CN&timestamp={timestamp}";
// "已经在编辑页"的判据：目标地址去掉 token / timestamp 后的固定部分。
// 必须用它而不是只判 "/cgi-bin/appmsg"：命中就停手，否则会带着新 timestamp 反复刷新页面
const EDIT_PAGE_MARK =
  "cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77&createType=0";
// 登录失效兜底：页面上"请重新<a id="jumpUrl">登录</a>"本身就指向登录页，取不到就用首页
const LOGIN_URL = "https://mp.weixin.qq.com/";

/** 图片上传接口：微信自己的素材上传，身份参数一律拼在 URL 上（见 buildUploadUrl） */
const UPLOAD_IMAGE_URL = "https://mp.weixin.qq.com/cgi-bin/filetransfer";

const CHECK_INTERVAL = 600;
// 编辑页是 SPA：地址先落到，编辑器随后才初始化完，所以要再盯着等一会儿。
// 就绪判据优先用微信自己的 mp_editor_get_isready，超时就放弃——宁可少灌一次，
// 也别一直转着重复写别人的编辑器
const EDITOR_WAIT_TIMEOUT = 30 * 1000;

let lastToken = ""; // 已回传过的 token，避免每 600ms 重复往 C++ 发
let filled = false; // 本文档已经灌过一轮：页面自身的后续刷新不该再糊一遍

/**
 * 本轮"文章已经交到微信编辑器里"了吗：null = 还没问到，由 native 的发布窗口说了算。
 * 微信发布成功后会跳回首页，脚本在新文档里整个重跑，这时候必须认出"这不是刚登录完停在首页"，
 * 否则会照老规矩把人又推回新建图文页——刚发完的那篇就这么被翻出来重填一遍。
 * 标志记在 native 侧而不是 sessionStorage：发布窗口是一轮一份、关窗即没，
 * 下一次发布天然从 false 开始，而不会像 storage 那样跨轮残留。
 */
let published = null;
let publishedAsked = false;

/** 问一次 native；每个文档只问一次（同一轮内答案不会变） */
function askPublishedOnce() {
  if (publishedAsked) return;
  publishedAsked = true;
  DDMsg.invoke("getPublished")
    .then((data) => {
      published = !!(data && data.published);
    })
    .catch(() => {
      // 问不到就按"没发过"办：最坏是维持原来的跳转行为，不会让人卡在首页
      published = false;
    });
}

/** 灌完告诉 native 一声：这一轮的目标已经达成了 */
function markPublished() {
  return DDMsg.invoke("setPublished").catch((err) =>
    console.log("[DraftDepot] 标记已发布失败", err),
  );
}

// 从地址里抠 token：微信把它放在 query 上（登录后的落地页、编辑页都有）
function getToken() {
  const matched = /[?&]token=(\d+)/.exec(location.href);
  return matched ? matched[1] : "";
}

/** ticket_id：cookie 里的（HttpOnly，页面读不到），取一次就够；没有就给空串，URL 上留空 */
let ticketId = null;

/**
 * 向 native 要 ticket_id：它是 HttpOnly，document.cookie 里没有，只能让 native 代读
 * （CookieManager 在 native 侧，不受 HttpOnly 限制）。拿不到就退 slave_user，再没有就空着
 */
async function getTicketId() {
  if (ticketId === null) {
    const cookies = await DDMsg.invoke("getCookie", { names: ["ticket_id", "slave_user"] });
    ticketId = (cookies && (cookies.ticket_id || cookies.slave_user)) || "";
  }
  return ticketId;
}

/** 页面全局变量 wx.* 上的身份参数：新编辑器页还在用这套（老编辑器同源于此） */
function wxData(path, fallback = "") {
  const value = path.split(".").reduce((obj, key) => (obj == null ? obj : obj[key]), window.wx);
  return value == null ? fallback : value;
}

/**
 * 拼上传地址：token / ticket / svr_time / ticket_id 全是它验身份用的，缺一个都传不上去。
 * seq 与 t 是它自己防缓存用的时间戳与随机数，随手造一个就行
 */
async function buildUploadUrl() {
  const params = new URLSearchParams({
    action: "upload_material",
    f: "json",
    scene: "8",
    writetype: "doublewrite",
    groupid: "1",
    ticket_id: await getTicketId(),
    ticket: wxData("commonData.data.ticket"),
    svr_time: wxData("cgiData.svr_time", Math.floor(Date.now() / 1000)),
    token: getToken(),
    lang: "zh_CN",
    seq: Date.now(),
    t: Math.random(),
  });
  return UPLOAD_IMAGE_URL + "?" + params.toString();
}

/** 上传序号：表单里的 id 字段（WebUploader 那套惯例），每张图一个 */
let uploadSeq = 0;

/**
 * 上传一张图，拿到它的图床地址。
 * 表单除 file（二进制）外还带 id / name / type / lastModifiedDate / size —— 它那套上传组件
 * （WebUploader）的惯例字段，照它自己发的那次补齐，缺了可能认不出这是个图片。
 * 返回 JSON 里 base_resp.ret 为 0 才算成，地址在 cdn_url
 */
async function uploadImage(file) {
  const form = new FormData();
  form.append("id", "WU_FILE_" + uploadSeq++);
  form.append("name", file.name);
  form.append("type", file.type || "image/png");
  form.append("lastModifiedDate", new Date(file.lastModified).toString());
  form.append("size", file.size);
  form.append("file", file);
  const res = await fetch(await buildUploadUrl(), { method: "POST", body: form, credentials: "include" });
  if (!res.ok) throw new Error("上传图片失败，HTTP " + res.status);
  const data = await res.json();
  if (!data.base_resp || data.base_resp.ret !== 0) {
    throw new Error("上传图片失败：" + (((data.base_resp || {}).err_msg) || "未知错误"));
  }
  if (!data.cdn_url) throw new Error("上传图片没返回地址");
  return data.cdn_url;
}

/** 微信用的 ProseMirror 编辑器：第 0 个是标题输入框，第 1 个是正文 */
function getEditors() {
  return document.querySelectorAll(".ProseMirror");
}

/** 往编辑器里派发一次 paste：这条路跟人在编辑器里 Ctrl+V 走的是同一套处理，格式才留得住 */
function paste(editor, type, data) {
  const dt = new DataTransfer();
  dt.setData(type, data);
  const ev = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", { value: dt });
  editor.dispatchEvent(ev);
}

/**
 * 标题：全选后 paste 一段纯文本，一次替换掉原有内容。
 * 不用 document.execCommand("insertText")：它已废弃，而且这里也没有更标准的替代品——
 * 标题输入框是 ProseMirror 的，只能由它自己的编辑器去改内容（它不认 beforeinput 那种通用事件），
 * 而 paste 是它明明白白接的一条路（见 paste 的说明）。
 * "替换"靠选区实现：全选后**不** collapseToEnd，粘贴时它见选区没折叠就先删后插，正好是整段替换；
 * 不先 deleteFromDocument：整块删要让它先消化一次"空文档"的 DOM 变更，随后的插入容易落错地方
 */
function setTitle(editor, text) {
  editor.focus();
  const sel = window.getSelection();
  sel.selectAllChildren(editor);
  paste(editor, "text/plain", text);
}

/** 老编辑器的正文：整段 HTML 一把 paste 进去（新编辑器走下面的 JSAPI） */
function setContentByPaste(editor, html) {
  editor.focus();
  const sel = window.getSelection();
  sel.selectAllChildren(editor); // 先把光标交给这块
  sel.collapseToEnd(); // 再收到末尾，paste 就成了"追加"，不会把编辑区的根节点给清掉
  paste(editor, "text/html", html);
}

/** 微信挂在页面上的编辑器 JSAPI：新编辑器才有，而且要等它自己初始化完才出现 */
function getJsApi() {
  const api = window.__MP_Editor_JSAPI__;
  return api && typeof api.invoke === "function" ? api : null;
}

/** 回调式的 JSAPI 包成 Promise，好跟 await 串起来；errCb 走 reject */
function invokeJsApi(apiName, apiParam) {
  return new Promise((resolve, reject) => {
    // get_isready 没有参数，apiParam 传 undefined 它自己会忽略
    getJsApi().invoke({ apiName: apiName, apiParam: apiParam, sucCb: resolve, errCb: reject });
  });
}

/** 编辑器状态：{ isReady, isNew } */
function getEditorState() {
  return invokeJsApi("mp_editor_get_isready");
}

/** 正文（新编辑器）：整篇富文本交给微信自己处理，比模拟一次 paste 稳 */
function setContentByApi(html) {
  return invokeJsApi("mp_editor_set_content", { content: html });
}

// —— 正文形态适配 ——
// 主编辑器给过来的是编辑器里的原始正文（roosterjs 的产物），进微信编辑器之前要摊平成它自己的段落结构：
//   <p style="font-size:14px;line-height:1.75"><span>文字</span><u><span>下划线</span></u></p>
// 即：块级一律摊平成 p，p 里的每段文本都套一层 span，行内格式（u / s / b / em…）原样留着。
// 这么转是为了绕开微信那条"行高小于字体大小，多行文本可能重叠"的提示：它按自己的 DOM 结构判版式，
// 行高偏小（含它给的默认值）就弹。这里每段都显式定死字号与行高，行高用倍数（1.75）而不是 px，
// 标题在微信里被放大时行高也跟着放大，不会重新跌破字号。
//
// 代码块不在这里动：它已经在 UI/src/EditorContent/WeiXinHtml.ts 里换成了微信自己的 code-snippet
// 结构并着好色——那份要用 shiki 着色，站点脚本是资源里的裸 JS，拿不到着色器。所以见着 pre.code-snippet
// 整块放行（见 convert 里的注释），别把它当普通 pre 拆一遍。
// 图片 src 也原样留着 https://app.localhost/images/<文件名>：那是本程序 WebView2 的虚拟映射，
// 微信的服务器取不到，由下面的 uploadImages 传图床后再换地址。

/** 正文段落字号：定死，不跟着编辑器里的字号走 */
const FONT_SIZE = "14px";

/** 行高：倍数，明显大于字号 */
const LINE_HEIGHT = "1.75";

/** 标题字号：沿用编辑器 #editorContent 里的级差（EditorContent.scss），免得落到微信的默认字号上 */
const HEADING_FONT_SIZE = {
  H1: "28px",
  H2: "24px",
  H3: "20px",
  H4: "18px",
  H5: "16px",
  H6: "15px",
};

/** 一律转成 p 的标签（编辑器里 roosterjs 出的是 div，微信认 p） */
const AS_P = new Set(["DIV", "P", "SECTION", "ARTICLE", "ADDRESS", "FIGURE", "FIGCAPTION", "BODY"]);

/** 保留原标签的块级容器：整体结构有意义（列表、引用、表格、代码块） */
const AS_CONTAINER = new Set(["UL", "OL", "BLOCKQUOTE", "PRE", "TABLE", "TBODY", "THEAD", "TR"]);

/** 保留原标签的块级单元：内容直接放行，不再往里套 p */
const AS_CELL = new Set(["LI", "TD", "TH"]);

/** 原样保留的元素：图片、换行、分割线，内容与属性都不动 */
const AS_IS = new Set(["IMG", "BR", "HR"]);

/** 所有块级标签：用来判断哪些节点不能塞进 p 里 */
const BLOCK_TAGS = new Set([...AS_P, ...AS_CONTAINER, ...AS_CELL, ...Object.keys(HEADING_FONT_SIZE)]);

/**
 * 清掉外边距：微信自己的段落间距够用，p 上带 margin 会跟它的排版打架。
 * 长写法（margin-top 之类）也一起清，免得只清了简写留下残余
 */
function clearMargin(el) {
  for (const prop of ["margin", "margin-top", "margin-right", "margin-bottom", "margin-left"]) {
    el.style.removeProperty(prop);
  }
}

function isBlock(node) {
  return node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(node.tagName);
}

/**
 * CSS 长度 → px 数值；解析不出长度时返回 NaN，兜底由调用方决定。
 * roosterjs 上报的字号是 pt（15px 对应 "11.25pt"），所以 pt→px 要 ×4/3
 */
function cssLengthToPx(length) {
  const matched = /^(\d+(?:\.\d+)?)\s*(px|pt)$/i.exec((length || "").trim());
  if (!matched) return NaN;
  const value = parseFloat(matched[1]);
  return matched[2].toLowerCase() === "px" ? value : (value * 4) / 3;
}

/**
 * 行高折算成"相对字号的倍数"：无单位与 em 直接用，% 除以 100，px 除以该元素字号；
 * 没写行高 / normal 返回 NaN（按"没定死"处理）
 */
function lineHeightRatio(value, fontPx) {
  const text = value.trim();
  const num = parseFloat(text);
  if (!text || text === "normal" || Number.isNaN(num)) return NaN;
  if (text.endsWith("px")) return num / fontPx;
  if (text.endsWith("%")) return num / 100;
  return num;
}

/** 元素字号（px）：没写 font-size 的按正文默认字号算 */
function fontSizePx(el, fallback = 14) {
  const px = cssLengthToPx(el.style.fontSize);
  return Number.isNaN(px) ? fallback : px;
}

/** 文本节点：套一层 span，微信的段落就是这么排的；缩进换行产生的纯空白丢掉 */
function convertText(node) {
  const text = node.nodeValue || "";
  if (!text || (!/\S/.test(text) && !text.includes("\u00a0"))) return [];
  const span = document.createElement("span");
  span.textContent = text;
  return [span];
}

/** 行内元素：标签与样式（颜色 / 粗体 / 字号…）原样留着，只纠正它自己写小的行高 */
function convertInline(el, children) {
  const out = el.cloneNode(false);
  const ratio = lineHeightRatio(out.style.lineHeight, fontSizePx(out));
  if (!Number.isNaN(ratio) && ratio < Number(LINE_HEIGHT)) out.style.lineHeight = LINE_HEIGHT;
  children.forEach((child) => out.appendChild(child));
  return [out];
}

/** 段落（p 及转成 p 的那些）：定死字号与行高，行内内容留在段内，里头嵌套的块摊平成兄弟段落 */
function convertParagraph(el, children) {
  const tag = el.tagName;
  const block = document.createElement(AS_P.has(tag) ? "p" : tag.toLowerCase());
  // 原段落的对齐 / 缩进等样式带过去，字号与行高随后压上，保证行高一定大于字号
  const style = el.getAttribute("style");
  if (style) block.setAttribute("style", style);
  clearMargin(block); // 原段落样式里带来的 margin 也一并去掉
  block.style.fontSize = HEADING_FONT_SIZE[tag] || FONT_SIZE;
  block.style.lineHeight = LINE_HEIGHT;

  const inline = children.filter((child) => !isBlock(child));
  const nested = children.filter(isBlock);
  // 空壳（比如只包了一个内层块）：不留空段落，直接把内层块提上来
  if (inline.length === 0 && nested.length > 0) return nested;
  inline.forEach((child) => block.appendChild(child));
  if (inline.length === 0) block.appendChild(document.createElement("br"));
  return [block, ...nested];
}

/** 容器（列表 / 引用 / 表格 / 代码块）：保留标签，子节点原样收下 */
function convertContainer(el, children) {
  const out = el.cloneNode(false);
  // 引用的结构样式（border-left / padding / 缩进）整条去掉，用微信自己的：
  // 它自带左侧竖线，我们那套叠上去会打架。只补一个底色——不写的话引用会跟正文糊在一起
  if (out.tagName === "BLOCKQUOTE") {
    out.removeAttribute("style");
    out.style.background = "#f6f6f6";
  }
  const ratio = lineHeightRatio(out.style.lineHeight, fontSizePx(out));
  if (!Number.isNaN(ratio) && ratio < Number(LINE_HEIGHT)) out.style.lineHeight = LINE_HEIGHT;
  for (const child of children) {
    // 列表里混进来的行内内容补个 li，免得 ul / ol 底下直接挂 span
    if ((out.tagName === "UL" || out.tagName === "OL") && !isBlock(child)) {
      const li = document.createElement("li");
      li.appendChild(child);
      out.appendChild(li);
    } else {
      out.appendChild(child);
    }
  }
  return [out];
}

/**
 * 递归转换：返回一组节点。
 * 块里套块的情况（div 里还有 div）会被摊平成兄弟节点，保证不会生成 p 套 p 这种微信认不出的结构
 */
function convert(node) {
  if (node.nodeType === Node.TEXT_NODE) return convertText(node);
  if (node.nodeType !== Node.ELEMENT_NODE) return [];

  const el = node;
  const tag = el.tagName;
  if (AS_IS.has(tag)) return [el.cloneNode(false)];

  // 代码块：已经是最终进微信的形状（code-snippet 结构 + shiki 内联色，见本节开头），整块原样带过去。
  // 再往下走就把它当成普通 pre 了——里面每行上的字号与行高会被 convertInline 按正文的那套纠正掉
  if (tag === "PRE" && el.classList.contains("code-snippet")) return [el.cloneNode(true)];

  const children = Array.from(el.childNodes).flatMap(convert);
  if (AS_CELL.has(tag)) {
    const out = el.cloneNode(false);
    children.forEach((child) => out.appendChild(child));
    return [out];
  }
  if (AS_CONTAINER.has(tag)) return convertContainer(el, children);
  if (AS_P.has(tag) || HEADING_FONT_SIZE[tag]) return convertParagraph(el, children);
  return convertInline(el, children);
}

/** 原始正文 → 微信编辑器认的那一版（段落摊平；代码块与图片不在这里动，见本节开头） */
function forWeiXin(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const root = document.createElement("div");

  // 顶层没有被任何块包住的行内内容（span / 裸文本）补一个 p，别让它直接挂在外面
  let pending = [];
  const flush = () => {
    if (pending.length === 0) return;
    const p = document.createElement("p");
    p.style.fontSize = FONT_SIZE;
    p.style.lineHeight = LINE_HEIGHT;
    pending.forEach((child) => p.appendChild(child));
    root.appendChild(p);
    pending = [];
  };
  for (const child of Array.from(doc.body.childNodes).flatMap(convert)) {
    if (isBlock(child)) {
      flush();
      root.appendChild(child);
    } else {
      pending.push(child);
    }
  }
  flush();
  return root.innerHTML;
}

async function fillArticle(useApi) {
  if (filled) return;
  filled = true;
  const article = await DDMsg.invoke("getArticle");
  // 两份都空 = 这一轮早给过了（页面刷新/跳转会让本脚本整个重跑），或这篇本来就没内容：都别动手
  if (!article || (!article.title && !article.html)) return;

  // 标题没有对应的 JSAPI（官方只给了正文相关的接口），还是往标题输入框里塞
  const editors = getEditors();
  if (article.title && editors[0]) setTitle(editors[0], article.title);
  // 先摊平成微信自己的段落结构（见 forWeiXin），图再换成它的图床地址
  // （传过的直接取旧地址，见 Msg.js），最后整篇灌进去
  const html = await DDImages.uploadImages(forWeiXin(article.html), uploadImage);
  if (!html) return;
  if (useApi) await setContentByApi(html);
  else if (editors[1]) setContentByPaste(editors[1], html);
}

/**
 * 到了编辑页：等编辑器就绪再把文章灌进去。
 * 就绪优先问微信自己（mp_editor_get_isready），不再靠数 ProseMirror 的个数。
 * 只有 isNew=true 才走 set_content —— 官方说明写得很清楚：这类接口只对新编辑器开放，
 * 老编辑器退回原来的 paste 路子。
 */
function waitEditorAndFill() {
  const startedAt = Date.now();
  let pending = false; // 上一拍的 await 还没回来，别叠下一次
  const wait = setInterval(async () => {
    if (pending) return;
    if (Date.now() - startedAt > EDITOR_WAIT_TIMEOUT) {
      clearInterval(wait);
      console.log("[DraftDepot] 等不到微信编辑器，放弃灌入");
      return;
    }
    pending = true;
    try {
      const jsApi = getJsApi();
      const state = jsApi ? await getEditorState() : null;
      const newEditor = !!(state && state.isReady && state.isNew);
      const oldEditor = getEditors().length >= 2;
      if (newEditor) {
        clearInterval(wait);
        // 传图 + 灌标题正文这一整段都盖着遮罩：那期间页面是半截的，别让人插手（见 Mask.js）
        await DDMask.withMask(() => fillArticle(true));
        await markPublished();
      } else if ((!jsApi || (state && state.isReady)) && oldEditor) {
        // 拿不到 JSAPI（老页面），或它明说了不是新编辑器：按老办法来
        clearInterval(wait);
        await DDMask.withMask(() => fillArticle(false));
        await markPublished();
      }
    } catch (err) {
      console.log("[DraftDepot] 灌文章失败", err);
    } finally {
      pending = false;
    }
  }, CHECK_INTERVAL);
}

const timer = setInterval(() => {
  // 只在顶层文档干活：注入脚本每个 iframe 也会跑一遍，别钻到别人的框里去做判断
  if (window.self !== window.top) return;

  // 先弄清本轮发过没有（每个文档只问一次）；答案没到之前这一拍什么都别做，
  // 免得在拿到答案前的那 600ms 里已经把人推回编辑页了
  askPublishedOnce();
  if (published === null) return;
  // 发过了：眼前这个页面多半是微信发布成功后自己跳回的首页，任务已完成，停手
  if (published) {
    clearInterval(timer);
    return;
  }

  // 登录态失效：页面出现"请重新登录"（<h2> 里带 #jumpUrl 那个链接）
  const jumpUrl = document.querySelector("#jumpUrl");
  const relogin =
    document.body && document.body.innerText.includes("请重新登录");
  if (jumpUrl || relogin) {
    clearInterval(timer);
    location.href = (jumpUrl && jumpUrl.getAttribute("href")) || LOGIN_URL;
    return;
  }

  const token = getToken();
  if (!token) return; // 登录页 / 首页没有 token，继续等

  // 只在 token 变了才回传：C++ 侧拿它跟 site 表里的比，不同才写库
  if (token !== lastToken) {
    lastToken = token;
    DDMsg.invoke("setParam", { key: "token", value: token });
  }

  // 已经在编辑页：本轮任务完成，停表，转去等编辑器渲染好后灌文章
  if (location.href.includes(EDIT_PAGE_MARK)) {
    clearInterval(timer);
    waitEditorAndFill();
    return;
  }
  // 有 token 但不在编辑页（比如刚登录完停在首页）：拼好地址跳过去，跳完就停表
  clearInterval(timer);
  location.href = CREATE_ARTICLE_URL.replace("{token}", token).replace(
    "{timestamp}",
    Date.now(),
  );
}, CHECK_INTERVAL);
