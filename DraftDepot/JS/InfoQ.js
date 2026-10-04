// 由 PageSite::injectSiteScript 注入到 xie.infoq.cn，每个文档（含跳转后）都会跑一遍。
// 注入时前面拼了 Msg.js，所以直接用它挂的 window.DDMsg 跟 native 说话。
// 职责：把"待发布的文章"（点发布按钮时由主编辑器交给 native 的）灌进 InfoQ 的编辑器。
//
// 与别的站点不一样的是要走两步：
//   1. 落地页是草稿箱 /draftbox。InfoQ 没有固定的"新建文章"地址——编辑页是 /draft/<id>，
//      id 由它服务端在建草稿时分配，所以先在草稿箱上调它自己的建草稿接口拿 id，再跳过去；
//   2. 编辑页 /draft/<id> 上灌内容：正文不给 HTML、也不自己写进富文本，而是把整篇 Markdown
//      做成 .md 文件交给工具条上那个"导入 Markdown"——它自己会把 Markdown 解析成富文本，
//      代码块的语言标识（```javascript 之类）也就跟着一起过去了；自己往富文本里塞，
//      语言只能丢（它的代码块语言是自己的一套下拉）。解析是纯本地的，不发上传请求。
//
// 登录不兜：没登录时 /draftbox 会被它送到首页（不是登录页），登录完也不会自动回来。
// 所以在首页什么都不做，等人自己进草稿箱——本脚本每跳一次都会重跑，进了草稿箱就接着干。
//
// 图片要额外跑一趟：正文里的图是 https://app.localhost/images/<文件名>（本程序 WebView2 的虚拟映射），
// InfoQ 的服务器取不到，得按文件名从本机图片目录取文件、传它的图床，拿到地址换掉 Markdown 里的图片
// 地址再做导入。取文件、传图床、换地址这套全由 Images.js 管（DDImages.uploadMarkdownImages），这里只留本站点自己的上传
// 接口 uploadImage——它的上传接口很省心（POST /api/v1/upload/form，图放在 FormData 的 file 字段里，
// 身份在 cookie 里），不用像掘金那样把文件塞回页面让它传（那边是火山 ImageX 五步加 V4 签名）。
// 目录句柄只能由 native 给：脚本跑在网页上下文里，碰不到本机文件系统，光有路径也造不出 File 对象。

/** 落地页：草稿箱。在这儿新建草稿，拿到 id 才有编辑页地址 */
const DRAFTBOX_PATH = "/draftbox";

/** 编辑页：/draft/<id>，id 是建草稿时它服务端给的 */
const EDIT_PAGE_PREFIX = "/draft/";

/** 建草稿：POST /api/v1/draft/create，空 body，身份在 cookie 里 → data.id */
const CREATE_DRAFT_URL = "/api/v1/draft/create";

/** 传图：POST 过去，图放在 FormData 的 file 字段里，身份在 cookie 里 → data.url */
const UPLOAD_IMAGE_URL = "/api/v1/upload/form";

const CHECK_INTERVAL = 600;

/** 导入 Markdown 后正文里出现内容的最长等待（本地解析，通常一两拍就有） */
const IMPORT_TIMEOUT = 30000;

/** 等导入结果时隔多久看一眼正文 */
const IMPORT_POLL_INTERVAL = 300;

/** 本文档里建草稿只许走一次：接口失败也别在同一页上反复建，不然草稿箱会攒一堆空草稿 */
let creating = false;

/** 标题输入框：.draft-title（Vue 受控组件） */
function getTitleInput() {
  return document.querySelector(".draft-title");
}

/**
 * 导入 Markdown 用的那个隐藏文件框：工具条上那个按钮点的就是它（accept=".md"）。
 * 页面上还有个 accept="image/*" 的（传图片用），所以按 accept 认，不按下标认
 */
function getMarkdownInput() {
  const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
  return inputs.find((input) => input.getAttribute("accept") === ".md") ?? null;
}

/** 正文编辑器：ProseMirror，可编辑区就是它 */
function getEditor() {
  return document.querySelector('[contenteditable="true"]');
}

/** 轮询里的"等一拍" */
function wait(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * 标题：Vue 受控组件（v-model 绑在 value 上），直接写 input.value 它收不到——
 * Vue 把实例上的 value 改写成自己的，写 DOM 属性只是改了这一个，它内部那个变量还是旧值，
 * 下一轮渲染就把改动冲掉了。只有 HTMLInputElement 原型上的原生 setter 能真正写进去，
 * 补一次 input 事件它才会当成"用户敲进去的"收进 model。
 *
 * 写完必须复查：这个框在 SPA 里常常比 Vue 的监听器早一步进 DOM，那一瞬派 input 没人接，
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
  console.log("[DraftDepot] 标题没能写进 InfoQ 的标题框");
}

/**
 * 建一篇空草稿，拿它的 id。
 * 页面上"立即创作"按钮也是先调这个接口再跳 /draft/<id> 的——照它做，比去点那个按钮稳：
 * 按钮是带 hash 的 class，改版就找不着了
 */
async function createDraft() {
  const response = await fetch(CREATE_DRAFT_URL, {
    method: "POST",
    credentials: "include", // 身份在 cookie 里
    headers: { "Content-Type": "application/json" },
    body: "",
  });
  const data = await response.json();
  const id = data && data.data && data.data.id;
  if (!id) throw new Error("建草稿没拿到 id");
  return id;
}

/**
 * 把整篇 Markdown 交给页面自己导入：塞进那个 .md 文件框、派一次 change 即可。
 * 之后的解析、转富文本、存草稿（pushFull）全是它自己的事，连代码块的语言都按围栏上写的走；
 * 没有回调可用，只能看着正文等它出现内容
 */
async function importMarkdown(input, markdown) {
  const file = new File([markdown], "article.md", { type: "text/markdown" });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files; // input.files 可写，塞进去它就当"用户选了这个文件"
  input.dispatchEvent(new Event("change", { bubbles: true }));

  const deadline = Date.now() + IMPORT_TIMEOUT;
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, IMPORT_POLL_INTERVAL));
    const editor = getEditor();
    if (editor && editor.textContent.trim()) return;
  }
  console.log("[DraftDepot] 等不到 Markdown 导入的结果");
}

/**
 * 上传一张图，拿到它的图床地址。
 * 不用把文件塞回页面让它传（掘金那边是不得不那么做）：这边就一个 POST /api/v1/upload/form，
 * 图放在 FormData 的 file 字段里、身份在 cookie 里，返回 data.url 就是图床地址
 * （https://static001.geekbang.org/infoq/<hash>.png）
 */
async function uploadImage(file) {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(UPLOAD_IMAGE_URL, {
    method: "POST",
    credentials: "include", // 身份在 cookie 里
    body: form,
  });
  const data = await response.json();
  const url = data && data.data && data.data.url;
  if (!url) throw new Error("上传没拿到地址");
  return url;
}

const timer = setInterval(async () => {
  // 只在顶层文档干活：注入脚本每个 iframe 也会跑一遍，别钻到别人的框里去做判断
  if (window.self !== window.top) return;
  const path = location.pathname;

  // —— 草稿箱：建一篇新草稿，跳到它的编辑页（跳转后本脚本会在新文档里重跑）——
  if (path === DRAFTBOX_PATH) {
    if (creating) return;
    creating = true;
    try {
      location.href = EDIT_PAGE_PREFIX + (await createDraft());
    } catch (err) {
      console.log("[DraftDepot] 新建草稿失败", err);
      creating = false;
    }
    return;
  }

  // 首页（没登录时会被送到这儿）与别的页面：都不动手，等人自己进草稿箱
  if (!path.startsWith(EDIT_PAGE_PREFIX)) return;

  // 编辑页是 SPA：地址先落到，标题框与编辑器随后才渲染出来
  const titleInput = getTitleInput();
  const mdInput = getMarkdownInput();
  if (!titleInput || !mdInput) return;
  clearInterval(timer); // 取到就停表：一个文档只灌一次

  const article = await DDMsg.invoke("getArticle");
  // 两份都空 = 这一轮早给过了（页面刷新/跳转会让本脚本整个重跑），或这篇本来就没内容：都别动手
  if (!article || (!article.title && !article.html)) return;

  // 灌标题正文这一整段都盖着遮罩：那期间页面是半截的，别让人插手（见 Mask.js）
  await DDMask.withMask(async () => {
    if (article.title) await setTitle(article.title);
    // 字段叫 html，这一趟装的其实是 Markdown（见文件头）：图先传上去换成图床地址，再整篇交给它
    // 自己的导入——语言标识跟着 Markdown 一起过去，自己塞进富文本就只能丢
    if (article.html) await importMarkdown(mdInput, await DDImages.uploadMarkdownImages(article.html, uploadImage));
    // 导入会把正文整块重渲染，标题可能被这一轮渲染冲掉；已经写进去的话这一句 300ms 内就回来了
    if (article.title) await setTitle(article.title);
  });
  console.log("[DraftDepot] 文章已灌入 InfoQ 编辑器");
}, CHECK_INTERVAL);
