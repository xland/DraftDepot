// 由 PageSite::injectSiteScript 注入到 juejin.cn，每个文档（含跳转后）都会跑一遍。
// 注入时前面拼了 Msg.js，所以直接用它挂的 window.DDMsg 跟 native 说话。
// 职责：进了文章编辑页（https://juejin.cn/editor/drafts/new?v=2，ByteMD 的 Markdown 编辑器）
// 就把"待发布的文章"（点发布按钮时由主编辑器交给 native 的）灌进掘金编辑器。
// 与开源中国/博客园同一套：正文在前端已经转成 Markdown（见 UI/src/EditorContent/Markdown.ts），
// 这里只管把它写进 CodeMirror，不做任何格式加工。
//
// 登录这件事不用脚本操心：没登录时打开编辑页会被掘金送到登录页，登录成功后又被自动送回
// ——那是另一次导航、另一个文档，本脚本会重新跑一遍。所以等编辑器就绪不设超时：
// 从登录页到人输完验证码可能要好几分钟，超时放弃就等于白跑一趟。
//
// 图片要额外跑一趟：正文里的图是 https://app.localhost/images/<文件名>（本程序 WebView2 的虚拟映射），
// 掘金的服务器取不到，得按文件名从本机图片目录取文件、传它的图床，拿到地址换掉 Markdown 里的图片地址
// 再灌进去。取文件、传图床、换地址这套全由 Images.js 管（DDImages.uploadMarkdownImages），这里只留本站点自己的上传
// 接口 uploadImage——它跟 OSC/CnBlogs 那两家不一样：不发自己的请求，而是把文件交给页面去传
// （见 uploadImage 上的说明）。目录句柄只能由 native 给：脚本跑在网页上下文里，碰不到本机文件系统，
// 光有路径也造不出 File 对象。

// 文章编辑页：新建草稿是 /editor/drafts/new，存过草稿后地址会带上草稿 id（/editor/drafts/<id>），
// 两个都得认——跟知乎一样，存盘后地址变了但活还得接着干。认这一个前缀而不是"只要 hostname 是
// juejin.cn 就干"，是为了避开前台的文章页与后台的其它页面（那些页面上也有 .bytemd 之外的编辑器）
const EDIT_PAGE_PREFIX = "/editor/drafts/";

const CHECK_INTERVAL = 600;

/** 传一张图最多等这么久：五步链路加网络，慢的时候要好几秒，大图更久 */
const UPLOAD_TIMEOUT = 60000;

/** 等的时候隔多久看一眼正文：上传完它会把 ![](地址) 插进来，那是唯一的信号 */
const UPLOAD_POLL_INTERVAL = 300;

/**
 * 正文编辑器：掘金用的是 ByteMD，Markdown 那一半就是 CodeMirror。
 * CodeMirror 初始化时把实例挂在自己那个容器上（.bytemd 里的 .CodeMirror）
 */
function getCodeMirror() {
  const cmEl = document.querySelector(".bytemd .CodeMirror");
  return cmEl ? cmEl.CodeMirror : null;
}

/** 标题输入框：.title-input */
function getTitleInput() {
  return document.querySelector(".title-input");
}

/**
 * 标题：Vue 受控组件（v-model 绑在 value 上），直接写 input.value 它收不到——
 * Vue 把实例上的 value 改写成自己的，写 DOM 属性只是改了这一个，它内部那个变量还是旧值，
 * 下一轮渲染就把改动冲掉了。只有 HTMLInputElement 原型上的原生 setter 能真正写进去，
 * 补一次 input 事件它才会当成"用户敲进去的"收进 model
 */
function setTitle(input, text) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * 上传一张图，拿到它的图床地址。
 *
 * 为什么自己不发请求：掘金走的是火山引擎 ImageX，取临时凭证（gen_token）→ 申请上传
 * （ApplyImageUpload）→ 传文件到 tos → 提交（CommitImageUpload）→ 换地址（get_img_url）五步，
 * 中间两步要火山 OpenAPI 的 V4 签名（HMAC-SHA256 加规范化请求串），aid、ServiceId、uuid 全是
 * 它自己的，抄一份到脚本里，它一改版就崩。页面自己的 ByteMD 注册了 paste 处理：给它一个带文件的
 * 粘贴事件，它就把这五步全跑完，然后把 `![文件名](地址)` 插进正文——所以只要把插进来的地址读出来
 * 就行，一个签名都不用算。
 *
 * 插进来的位置是正文末尾（不认选区：实测先选中占位再粘贴，占位不动、图跑到最后），所以传之前
 * 先把编辑器清空：这样粘贴完正文里只有这一张，抠地址不会抠到别的上。灌正文是最后一步 setValue，
 * 中间这些空档不会被用户看见（整段都盖着遮罩）。
 *
 * 上传是异步的、也没有回调可用，只能轮询正文等那一行出现；等到或超时为止（超时由 Images.js 接住，
 * 那张图保留原地址，不拦别的）
 */
async function uploadImage(file) {
  const cm = getCodeMirror();
  if (!cm) throw new Error("编辑器不在了");
  cm.setValue(""); // 清空：粘贴完正文里就只有这一张图

  const transfer = new DataTransfer();
  transfer.items.add(file);
  const pasted = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
  // clipboardData 是只读的，只能把它重新定义成这一个属性，好把文件带进去
  Object.defineProperty(pasted, "clipboardData", { value: transfer });
  // ByteMD 的 paste 挂在 CodeMirror 那个隐藏 textarea 上，事件发到那儿它才收得到
  cm.getInputField().dispatchEvent(pasted);

  /** 它插进来的那一行：![文件名](地址) */
  const uploaded = /!\[[^\]]*\]\(([^)\s]+)\)/;
  const deadline = Date.now() + UPLOAD_TIMEOUT;
  let url = "";
  // 连着两轮读到同一个地址才算传完：第一眼看到的可能还是半截
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, UPLOAD_POLL_INTERVAL));
    const matched = cm.getValue().match(uploaded);
    if (!matched) continue;
    if (matched[1] === url) return url;
    url = matched[1];
  }
  throw new Error("等不到上传结果");
}

const timer = setInterval(async () => {
  // 只在顶层文档干活：注入脚本每个 iframe 也会跑一遍，别钻到别人的框里去做判断
  if (window.self !== window.top) return;
  if (!location.pathname.startsWith(EDIT_PAGE_PREFIX)) return; // 登录页 / 别的页面：等它自己跳回编辑页

  // 编辑页是 SPA：地址先落到，ByteMD 随后才把 CodeMirror 建出来
  const cm = getCodeMirror();
  const titleInput = getTitleInput();
  if (!cm || !titleInput) return;
  clearInterval(timer); // 取到就停表：一个文档只灌一次

  const article = await DDMsg.invoke("getArticle");
  // 两份都空 = 这一轮早给过了（页面刷新/跳转会让本脚本整个重跑），或这篇本来就没内容：都别动手
  if (!article || (!article.title && !article.html)) return;

  // 灌标题正文这一整段都盖着遮罩：那期间页面是半截的，别让人插手（见 Mask.js）
  await DDMask.withMask(async () => {
    if (article.title) setTitle(titleInput, article.title);
    // 字段叫 html，这一趟装的其实是 Markdown（见文件头）：图先传上去换成图床地址再灌进去
    // （见文件头说明）。传图会把编辑器清空腾地方，所以正文一定在传完之后再写——
    // CodeMirror 的 setValue 会触发 change，ByteMD 自己会把它收进 model，右侧预览跟着刷新，
    // 不用像标题那样绕 Vue
    if (article.html) cm.setValue(await DDImages.uploadMarkdownImages(article.html, uploadImage));
  });
  console.log("[DraftDepot] 文章已灌入掘金编辑器");
}, CHECK_INTERVAL);
