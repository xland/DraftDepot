// 由 PageSite::injectSiteScript 注入到 editor.csdn.net，每个文档（含跳转后）都会跑一遍。
// 注入时前面拼了 Msg.js（window.DDMsg，跟 native 说话），所以站点脚本里直接用它，
// 不用各自再写一遍 postMessage / 回包配对。
// 职责：进了写作页就把"待发布的文章"（点发布按钮时由主编辑器交给 native 的）灌进 CSDN 编辑器。
// 与开源中国 / 博客园同一套：正文在前端已经转成 Markdown（见 UI/src/EditorContent/Markdown.ts），
// 这里只管把它写进编辑器，不做任何格式加工。
//
// CSDN 有两套写作页，走的是 editor.csdn.net/md/ 这个 Markdown 编辑器（左边源码、右边预览）：
//   - 另一套是 mp.csdn.net 的富文本编辑器（CKEditor + codesnippet 组件）。早先发布走的是它，
//     代价是代码块得先拼成 CKEditor 的组件形状（连同一份自带着色），稍有偏差语言就丢、代码块变空。
//     换成 Markdown 那条之后代码块就是围栏 + 语言，语言本来就在围栏上，那一份加工整个不需要了
//     ——原先留在 UI/src/EditorContent/CSDNHtml.ts 里的代码也就跟着删掉了。
//   - /md/ 后面的 ?not_checkout=1 是它"新建文章"的入口，不带会被落到"接着编上一篇草稿"上
//     （落地地址见 PageSite.cpp 顶部的 siteHome）。
//
// 登录这件事不用脚本操心：没登录时打开写作页会被 CSDN 送到登录页，登录成功后又被自动送回写作页
// ——那是另一次导航、另一个文档，本脚本会重新跑一遍。所以等"编辑区出现"不设超时：
// 从登录页到人输完验证码可能要好几分钟，超时放弃就等于白跑一趟。
//
// 图片是唯一要额外跑一趟的事，而且**必须赶在 Markdown 写进编辑器之前**：正文里的图是
// https://app.localhost/images/<文件名>（本程序 WebView2 的虚拟映射，CSDN 的服务器取不到），
// 带着这个地址进去，它立刻就把那张图替换成"[外链图片转存中...(img-xxx)]"——它会自己去抓外链图重传，
// 而 app.localhost 只有本程序解析得到，它永远抓不回来，这张图就废了。
// 所以按文件名从本机图片目录取文件、传它的图床，拿到地址换掉 Markdown 里的图片地址再灌进去。
// 取文件与"这张图传过没有"由 Images.js 管（DDImages.uploadMarkdownImages），这里只留 CSDN 自己的上传
// 接口 uploadImage。目录句柄只能由 native 给：脚本跑在网页上下文里，碰不到本机文件系统，
// 光有路径也造不出 File 对象。

// 写作页：认路径而不是 hostname——它的编辑页、预览、后台都在 editor.csdn.net 上。
// 尾斜杠可有可无：自动保存过一次后它会把 /md/ 改写成 /md（后面挂 ?articleId=…），两种都算数
const EDIT_PAGE = "/md";

/** 当前是不是写作页（编辑已有草稿是 /md/<id>，那种不该动：本脚本只在新建的那篇里灌一次） */
function isEditPage() {
  return location.pathname.replace(/\/+$/, "") === EDIT_PAGE;
}

const CHECK_INTERVAL = 600;

/** 编辑区还没就绪时重试的间隔与次数：cledit 初始化完了，写进去的才不会被它自己的重排冲掉 */
const RETRY_INTERVAL = 600;
const MAX_ATTEMPTS = 3;

/** 落笔后到校验之间留的余量：它对 paste / input 的处理未必在同一个 tick 里收尾 */
const PASTE_SETTLE = 100;

let filled = false; // 本文档已经灌过一轮：页面自身的后续刷新不该再糊一遍

/**
 * 正文编辑区：它的 Markdown 源码编辑器是 cledit，编辑区是
 * <pre class="editor__inner" contenteditable="true">，里面每行一个 div.cledit-section
 * （源码 + 着色的 span），不是 textarea
 */
function getContentBox() {
  return document.querySelector("pre.editor__inner[contenteditable]");
}

/** 标题输入框：写作页顶部那个 input.article-bar__title */
function getTitleInput() {
  return document.querySelector("input.article-bar__title");
}

/**
 * 赋值：走原型上的原生 setter，再派发一次 input 事件。
 * 页面是 Vue（v-model 绑在 value 上）：Vue 把实例上的 value 改写成自己的，直接 el.value = x
 * 只改了 DOM 属性，它内部那个变量还是旧值，下一轮渲染就把改动冲掉了；只有原型上的原生 setter
 * 能真正写进去，补一个 input 事件它才会当成"用户敲进去的"收进 model（顺带刷新字数与预览）
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
 * 走页面自己的上传函数 window.csdn.upload.uploadImg({ appName, type, imageTemplate, file })：
 * 图床地址、鉴权、签名全在它自己手里，我们只把文件交出去，省得跟着它换接口。
 * 返回值整份打到控制台：约定是拿 [0].data.data.imageUrl，哪天它改了结构，照着打印改这一行就行
 */
async function uploadImage(file) {
  const result = await window.csdn.upload.uploadImg({
        appName: "direct_blog",
        type: "blog",
        imageTemplate: "",
        file: file
    });
  console.log("[DraftDepot] uploadImg 返回", result);
  return result[0].data.data.imageUrl;
}

/** 选中编辑区的全部内容：随后的编辑命令 / paste 会把这整块替掉 */
function selectAllOf(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * 清空编辑区：全选 → delete，删不干净就直接把 DOM 清了再照会它一声。
 * 每次写入前都必须清一遍：它对 insertText / paste 的处理是"插到当前选区处"，选区万一没落在
 * 整段上（它自己挪过光标、或上一轮留下残骸），落笔就变成追加，正文会被整篇写进去两遍。
 * delete 有可能被它自己的 beforeinput 拦掉，所以留了一条兜底——它是按 DOM 读内容的，
 * 清空后紧接着就写，不会留下不一致
 */
function clearBox(el) {
  el.focus();
  selectAllOf(el);
  document.execCommand("delete");
  if (stripSpace(el.textContent || "")) {
    el.replaceChildren();
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
  }
}

/** 间隔一拍：写入之后它的处理未必同步收尾，校验前给它一点时间 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 不换行空格：空行位置放一个，免得那一行的盒子塌掉 */
const NBSP = String.fromCharCode(160);

/**
 * 比对用：空白一律抹掉。
 * 行本是两个 box 之间的边界而不是文本，编辑区里的源码不像原文那样一字不差地带着换行；
 * 只比"是不是这一份内容"，换行立没立得起来由下面的 linesKept 单独验
 */
function stripSpace(text) {
  return (text || "").replace(/\s/g, "");
}

/** 编辑区里的源码：按渲染取，行才能得到换行（textContent 是行与行直接粘在一起的） */
function currentText(el) {
  return el.innerText || el.textContent || "";
}

/**
 * 编辑区里有几行是有内容的：优先数它的行盒子（每行一个 .cledit-section），数不着再按渲染的行数算。
 * 空行不计——它给空行也建盒子（里面塞个不换行空格撑着），而 Markdown 里的空行只是块与块之间的
 * 分隔，不是内容；两边都按"有内容的行数"算才比得起来
 */
function lineCount(el) {
  const sections = Array.from(el.querySelectorAll(".cledit-section"));
  if (sections.length) {
    return sections.filter((section) => stripSpace(section.textContent)).length;
  }
  return (el.innerText || "").split("\n").filter((line) => line.trim()).length;
}

/** 行有没有保住：目标有 N 行，编辑区也该差不多 N 行 */
function linesKept(el, text) {
  const expect = text.split("\n").filter((line) => line.trim()).length;
  return expect <= 1 || lineCount(el) === expect;
}

/** 写成了吗：内容是这一份、行结构也在 */
function checkWritten(el, text) {
  return stripSpace(currentText(el)) === stripSpace(text) && linesKept(el, text);
}

/**
 * 首选写法：给它派发一次带纯文本的 paste，走的就是人手 Ctrl+V 那条流水线。
 * 它拿到剪贴板里的文本后会自己按行重建编辑区结构——换行、代码块围栏这些都是这么立起来的。
 * 之前用的是 execCommand("insertText")，那是把整段当"一段文字"插进去，换行符在 <pre> 里能不能
 * 站得住全看它随后的重排，实测糊成了一整行，所以换到这里。
 */
async function tryPaste(el, text) {
  clearBox(el);
  el.focus();
  selectAllOf(el);
  const transfer = new DataTransfer();
  transfer.setData("text/plain", text);
  el.dispatchEvent(new ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    clipboardData: transfer,
  }));
  await sleep(PASTE_SETTLE);
  return checkWritten(el, text);
}

/**
 * 次选：按它自己的行结构直接写 DOM——每行一个 div.cledit-section。
 * 不扮演它的着色（那一堆 span），只保证行边界是对的：它按 DOM 读内容，随后的高亮与预览
 * 会自己重算。空行塞一个不换行空格，免得那行的盒子塌了导致它对不上行
 */
async function writeLines(el, text) {
  clearBox(el);
  for (const line of text.replace(/\n$/, "").split("\n")) {
    const section = document.createElement("div");
    section.className = "cledit-section";
    section.textContent = line.trim() ? line : NBSP;
    el.appendChild(section);
  }
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  await sleep(PASTE_SETTLE);
  return checkWritten(el, text);
}

/** 兜底：还是那个 execCommand，内容多半能进、换行可能糊——前两条都不成时才轮到它 */
async function tryInsert(el, text) {
  clearBox(el);
  el.focus();
  selectAllOf(el);
  document.execCommand("insertText", false, text);
  await sleep(PASTE_SETTLE);
  return checkWritten(el, text);
}

/**
 * 把整段 Markdown 写进编辑区：三条路依次试，一条成了就收。
 * 每条都以清空开头，所以怎么重试都不会把正文叠加两遍（上一版就是这么写出两张图的）
 */
async function setContent(el, text) {
  return (await tryPaste(el, text)) || (await writeLines(el, text)) || (await tryInsert(el, text));
}

/**
 * 写正文：写不进去就隔一拍再来，最多 MAX_ATTEMPTS 次。
 * 编辑区出现在 DOM 里的那一刻 cledit 未必已经初始化完，那会儿写进去的内容会被它随后的首次重排
 * 清掉；重试几轮就跨过去了。全都失败也不拦别的——留一条日志，人还能自己粘一次
 */
async function writeContent(el, text) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (await setContent(el, text)) return true;
    await sleep(RETRY_INTERVAL);
  }
  // 留一条够看懂的日志：期望多少字多少行，实际多少字多少行
  console.log("[DraftDepot] Markdown 没能写进 CSDN 编辑区，期望", text.replace(/\s/g, "").length,
    "字", text.split("\n").filter((line) => line.trim()).length, "行；实际",
    stripSpace(currentText(el)).length, "字", lineCount(el), "行");
  return false;
}

const timer = setInterval(async () => {
  // 只在顶层文档干活：注入脚本每个 iframe 也会跑一遍，别钻到别人的框里去做判断
  if (window.self !== window.top) return;
  if (!isEditPage()) return; // 登录页 / 别的页面：等它自己跳回写作页

  // 写作页是 SPA：地址先落到，标题框与编辑区随后才渲染出来
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
    // 字段叫 html，这一趟装的其实是 Markdown（见文件头）：图先传上去换成图床地址再写进编辑区
    if (article.html) {
      const markdown = await DDImages.uploadMarkdownImages(article.html, uploadImage);
      await writeContent(contentBox, markdown);
    }
  });
  console.log("[DraftDepot] 文章已灌入 CSDN 编辑器");
}, CHECK_INTERVAL);
