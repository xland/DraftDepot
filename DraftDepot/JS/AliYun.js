// 由 PageSite::injectSiteScript 注入到 developer.aliyun.com，每个文档（含跳转后）都会跑一遍。
// 注入时前面拼了 Msg.js，所以直接用它挂的 window.DDMsg 跟 native 说话。
// 职责：进了写文章页（https://developer.aliyun.com/article/new#/）就把"待发布的文章"
// （点发布按钮时由主编辑器交给 native 的）灌进它的编辑器。
//
// 它的编辑器是阿里云自研的 mditor：左边 Markdown 源码（textarea.textarea）、右边实时预览
// （.viewer .markdown-body），工具条上那排 data-cmd 就是它的命令。所以跟掘金同一套：
// 正文在前端已经转成 Markdown（见 UI/src/EditorContent/Markdown.ts），这里只管把它写进
// 源码框，不做任何格式加工——写进去右边预览立刻跟着渲染出来。
//
// 登录这件事不用脚本操心：没登录时打开写文章页会被它送到 account.aliyun.com，登录成功后
// 又被自动送回 ——那是另一次导航、另一个文档，本脚本会重新跑一遍。所以等编辑器就绪不设超时：
// 从登录页到人输完验证码可能要好几分钟，超时放弃就等于白跑一趟。
//
// 图片要额外跑一趟：正文里的图是 https://app.localhost/images/<文件名>（本程序 WebView2 的
// 虚拟映射），它的服务器取不到，得按文件名从本机图片目录取文件、传它的图床，拿到地址换掉
// Markdown 里的图片地址再灌进去。取文件、传图床、换地址这套全由 Images.js 管（DDImages.uploadMarkdownImages），
// 这里只留本站点自己的上传接口 uploadImage——与掘金同一套路：自己不发请求，而是把文件塞进
// 一个 paste 事件交给页面去传（见 uploadImage 上的说明）。
// 目录句柄只能由 native 给：脚本跑在网页上下文里，碰不到本机文件系统，光有路径也造不出 File。

// 写文章页：新建就这一个地址。认这一个前缀而不是"只要 hostname 是 developer.aliyun.com 就干"，
// 是为了避开前台的文章页与社区其它页面（那些页面上没有 mditor，但判断起来不如直接认地址清楚）
const EDIT_PAGE_PREFIX = "/article/new";

const CHECK_INTERVAL = 600;

/** 传一张图最多等这么久：实测一张图一秒多就回来了，留足网络不好的余量 */
const UPLOAD_TIMEOUT = 60000;

/** 等的时候隔多久看一眼正文：上传完它会把 ![](地址) 插进来，那是唯一的信号 */
const UPLOAD_POLL_INTERVAL = 300;

/** 轮询里的"等一拍" */
function wait(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/** 正文源码框：mditor 的 textarea.textarea（在 .mditor .editor 里） */
function getEditor() {
  return document.querySelector(".mditor textarea.textarea");
}

/**
 * 标题输入框：页面上那个唯一的、placeholder 是"请填写标题"的框。
 * 它自己没带 class（fusion 的表单组件把 class 都挂在父级上），所以只能按 placeholder 认；
 * 万一文案改了，退回"第一个 placeholder 里带'标题'的文本框"
 */
function getTitleInput() {
  return (
    document.querySelector('input[placeholder="请填写标题"]') ??
    Array.from(document.querySelectorAll("input[type=text]")).find((input) =>
      (input.placeholder || "").includes("标题"),
    ) ??
    null
  );
}

/**
 * 标题：受控组件（输入框的 value 被框架改写过），直接写 input.value 它收不到——
 * 只有 HTMLInputElement 原型上的原生 setter 能真正写进去，补一次 input 事件它才会当成
 * "用户敲进去的"收进 model。
 *
 * 写完必须复查：这个框在 SPA 里常常比框架的监听器早一步进 DOM，那一瞬派 input 没人接，
 * 写进去的 value 会被它下一次渲染冲回空串——在控制台里手敲同样的代码能成，
 * 正是因为那时候页面已经稳了。所以写完等一拍看 value 还在不在，被冲掉就重取元素再来一次；
 * 元素每轮重取：SPA 也可能把整个框换掉，攥着旧节点写就是白写
 */
async function setTitle(text, tries = 5) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  for (let i = 0; i < tries; i++) {
    const input = getTitleInput();
    if (!input) {
      await wait(300);
      continue;
    }
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(300);
    if (input.value === text) return;
  }
  console.log("[DraftDepot] 标题没能写进阿里云的标题框");
}

/**
 * 正文：直接写源码框的 value 再派一次 input——mditor 收到就同步预览（右边立刻渲染出来）。
 * 同样要复查：写早了会被它下一次渲染冲掉（理由同 setTitle）
 */
async function setContent(text, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const editor = getEditor();
    if (!editor) {
      await wait(300);
      continue;
    }
    editor.value = text;
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(300);
    if (editor.value === text) return;
  }
  console.log("[DraftDepot] 正文没能写进阿里云的编辑器");
}

/**
 * 上传一张图，拿到它的图床地址。
 *
 * 为什么自己不发请求：mditor 不管上传，图片是页面业务层接着的——它监听到粘贴里有图片文件，
 * 就自己传到 ucc.alicdn.com（地址形如 https://ucc.alicdn.com/pic/developer-ecology/<hash>.png），
 * 然后把 `![文件名](地址)` 插进源码。这套请求要带它自己的身份与签名，抄一份到脚本里，
 * 它一改版就崩；给它一个带文件的粘贴事件，它就把整条链路跑完，我们只要把插进来的地址读出来。
 *
 * 插进来的位置是当前光标（实测光标在末尾就插末尾），所以传之前先把源码框清空：这样粘贴完
 * 正文里只有这一张，抠地址不会抠到别的上。灌正文是最后一步 setValue，中间这些空档不会被
 * 用户看见（整段都盖着遮罩）。
 *
 * 上传是异步的、也没有回调可用，只能轮询正文等那一行出现；等到或超时为止（超时由 Images.js 接住，
 * 那张图保留原地址，不拦别的）
 */
async function uploadImage(file) {
  const editor = getEditor();
  if (!editor) throw new Error("编辑器不在了");
  editor.value = ""; // 清空：粘贴完正文里就只有这一张图
  editor.dispatchEvent(new Event("input", { bubbles: true }));

  const transfer = new DataTransfer();
  transfer.items.add(file);
  const pasted = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
  // clipboardData 是只读的，只能把它重新定义成这一个属性，好把文件带进去
  Object.defineProperty(pasted, "clipboardData", { value: transfer });
  editor.dispatchEvent(pasted);

  /** 它插进来的那一行：![文件名](地址) */
  const uploaded = /!\[[^\]]*\]\(([^)\s]+)\)/;
  const deadline = Date.now() + UPLOAD_TIMEOUT;
  let url = "";
  // 连着两轮读到同一个地址才算传完：第一眼看到的可能还是半截
  while (Date.now() < deadline) {
    await wait(UPLOAD_POLL_INTERVAL);
    const matched = editor.value.match(uploaded);
    if (!matched) continue;
    if (matched[1] === url) return url;
    url = matched[1];
  }
  throw new Error("等不到上传结果");
}

const timer = setInterval(async () => {
  // 只在顶层文档干活：注入脚本每个 iframe 也会跑一遍，别钻到别人的框里去做判断
  if (window.self !== window.top) return;
  if (!location.pathname.startsWith(EDIT_PAGE_PREFIX)) return; // 登录页 / 别的页面：等它自己跳回写文章页

  // 页面是 SPA：地址先落到，mditor 随后才把源码框与标题框建出来
  const editor = getEditor();
  const titleInput = getTitleInput();
  if (!editor || !titleInput) return;
  clearInterval(timer); // 取到就停表：一个文档只灌一次

  const article = await DDMsg.invoke("getArticle");
  // 两份都空 = 这一轮早给过了（页面刷新/跳转会让本脚本整个重跑），或这篇本来就没内容：都别动手
  if (!article || (!article.title && !article.html)) return;

  // 灌标题正文这一整段都盖着遮罩：那期间页面是半截的，别让人插手（见 Mask.js）
  await DDMask.withMask(async () => {
    if (article.title) await setTitle(article.title);
    // 字段叫 html，这一趟装的其实是 Markdown（见文件头）：图先传上去换成图床地址再灌进去。
    // 传图会把源码框清空腾地方，所以正文一定在传完之后再写
    if (article.html) await setContent(await DDImages.uploadMarkdownImages(article.html, uploadImage));
  });
  console.log("[DraftDepot] 文章已灌入阿里云编辑器");
}, CHECK_INTERVAL);
