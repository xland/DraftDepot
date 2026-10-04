// 由 PageSite::injectSiteScript 注入到 blog.51cto.com，每个文档（含跳转后）都会跑一遍。
// 注入时前面拼了 Msg.js，所以直接用它挂的 window.DDMsg 跟 native 说话。
// 职责：进了文章编辑页（https://blog.51cto.com/blogger/publish，Markdown 编辑器）就把
// "待发布的文章"（点发布按钮时由主编辑器交给 native 的）灌进 51CTO 编辑器。
// 与掘金/博客园同一套：正文在前端已经转成 Markdown（见 UI/src/EditorContent/Markdown.ts），
// 这里只管把它写进编辑器，不做任何格式加工。
//
// 登录这件事不用脚本操心：没登录时打开 /blogger/publish 会被 51CTO 送到登录页，登录成功后又被
// 自动送回——那是另一次导航、另一个文档，本脚本会重新跑一遍。所以等编辑器就绪不设超时：
// 从登录页到人输完验证码可能要好几分钟，超时放弃就等于白跑一趟。
//
// 编辑器这一层比别家省心：正文不是 CodeMirror，就是一个纯 textarea（.write-area），
// 写进去它自己渲染预览、自己数"共多少字"，也不用像掘金那样绕 Vue 的受控组件（见下面 setValue）。
//
// 图片要额外跑一趟：正文里的图是 https://app.localhost/images/<文件名>（本程序 WebView2 的虚拟映射），
// 51CTO 的服务器取不到，得按文件名从本机图片目录取文件、传它的图床，拿到地址换掉 Markdown 里的图片
// 地址再灌进去。取文件、传图床、换地址这套全由 Images.js 管（DDImages.uploadMarkdownImages），这里只留本站点自己的上传
// 接口 uploadImage——它的图床是腾讯云 COS，走三步（取签名 → 取上传参数 → POST 到 COS），
// 但签名是服务端给的、随取随用，不用自己算，所以脚本自己发请求就行，不必把文件塞回页面让它传。
// 目录句柄只能由 native 给：脚本跑在网页上下文里，碰不到本机文件系统，光有路径也造不出 File 对象。

// 文章编辑页：/blogger/publish 是写文章；存成草稿后它不换地址（草稿 id 是它自己另存的），
// 所以认这一个前缀就够了。认前缀而不是"只要 hostname 是 blog.51cto.com 就干"，
// 是为了避开博客前台的文章页与创作中心的其它页面
const EDIT_PAGE_PREFIX = "/blogger/publish";

const CHECK_INTERVAL = 600;

/** 写完停一拍再复核：给页面自己那一轮重渲染留足时间（见 fillTitle） */
const TITLE_SETTLE = 400;

let filled = false; // 本文档已经灌过一轮：页面自身的后续刷新不该再糊一遍

// —— 图片 ——
// 三步：getUploadSign 拿签名 → getUploadConfig 拿 COS 的上传参数（含目标 key）→ 把文件 POST 到 COS。
// 两步凭证请求都是 form-urlencoded，身份在 cookie 里（同源请求默认就带上）。
// 最终地址是签名那一步给的 CDN 前缀 + 上传参数里的 key，不用等它回包里给——
// 它自己插进正文的也是这个拼法，只不过尾巴上还挂了水印参数（x-oss-process=...），
// 那是它给博客图加的水印，我们不挂：不带参数取到的就是原图（实测 200 image/png）

const UPLOAD_SIGN_URL = "https://blog.51cto.com/getUploadSign";
const UPLOAD_CONFIG_URL = "https://blog.51cto.com/getUploadConfig";

/** 标题输入框：#title（placeholder 是"请输入标题，您可以输入100个字"） */
function getTitleInput() {
  return document.getElementById("title");
}

/** 正文输入框：textarea.write-area（Markdown 源码就在这里，右边是它的预览） */
function getTextArea() {
  return document.querySelector("textarea.write-area");
}

/**
 * 写一个输入框（标题是 input、正文是 textarea，两个都走这里）。
 * 页面是 Vue2（那些下拉框是 Element UI 的 el-input__inner），标题与正文虽不是 Element 组件，
 * 但一样是受控的：直接写 el.value 它收不到——只有原型上的原生 setter 能真正写进去，
 * 补一次 input 事件它才当成"用户敲进去的"：字数统计、预览、自动保存都挂在 input 上。
 * change 也补发一份：万一它被绑成 v-model.lazy（失焦才认），只发 input 是收不到的
 */
function setValue(el, text) {
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** 等一会儿：Promise 版的 setTimeout，好跟 await 串起来 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 写标题：写了还得回头复核，不看这一眼，正文一进来它就白写了。
 * 编辑页是 Vue2（还在服务端就把 HTML 吐出来了）：脚本见到标题框的时候，Vue 未必已经接管它——
 * 那时写的 value 与那一记 input 都没人听，data.title 依旧是空串，随后任何一次渲染都会按这个值
 * 把框刷回空。偏偏紧随其后的"写正文"必定带起一次渲染（重算预览、重数字数、自动存草稿），
 * 于是标题总在正文之后不见。
 * 补写没有副作用（标题不长、也不是累加），所以最多试三回；都不成就认了，由调用方的日志收场
 */
async function fillTitle(el, text) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (el.value === text) return true; // 还在，不必动
    setValue(el, text);
    await sleep(TITLE_SETTLE);
  }
  return el.value === text;
}

/** 两个凭证请求：form-urlencoded 发过去，回包是 { code, data } */
async function postForm(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body,
  });
  const data = await response.json();
  if (!data || data.code !== 0 || !data.data) throw new Error("取不到上传凭证：" + url);
  return data.data;
}

/**
 * 上传一张图，拿到它的图床地址。
 * 三步：签名 → 上传参数 → 把文件 POST 到它给的 COS 地址（回包 204 就是成了）。
 * 表单里除了参数那几个字段，还得带 content-type（COS 表单要，参数里没给），文件字段名是 file
 */
async function uploadImage(file) {
  const sign = await postForm(UPLOAD_SIGN_URL, "upload_type=image");
  const config = await postForm(
    UPLOAD_CONFIG_URL,
    new URLSearchParams({
      upload_type: "image",
      upload_sign: sign.sign,
      ext: file.type,
      name: file.name,
    }),
  );
  const payload = new FormData();
  for (const name in config.fields) payload.append(name, config.fields[name]);
  payload.append("content-type", file.type); // 参数里没给，但 COS 表单要它
  payload.append("file", file);
  const uploaded = await fetch(config.url, { method: "POST", body: payload });
  if (uploaded.status !== 200 && uploaded.status !== 204) {
    throw new Error("传图失败，HTTP " + uploaded.status);
  }
  return sign.url + config.fields.key; // CDN 前缀 + key = 图片地址
}

const timer = setInterval(async () => {
  // 只在顶层文档干活：注入脚本每个 iframe 也会跑一遍，别钻到别人的框里去做判断
  if (window.self !== window.top) return;
  if (!location.pathname.startsWith(EDIT_PAGE_PREFIX)) return; // 登录页 / 别的页面：等它自己跳回编辑页

  // 编辑页可能是渐进渲染的：地址先落到，标题框与正文框随后才出来
  const titleInput = getTitleInput();
  const textArea = getTextArea();
  if (!titleInput || !textArea) return;
  clearInterval(timer); // 取到就停表：一个文档只灌一次
  if (filled) return;
  filled = true;

  const article = await DDMsg.invoke("getArticle");
  // 两份都空 = 这一轮早给过了（页面刷新/跳转会让本脚本整个重跑），或这篇本来就没内容：都别动手
  if (!article || (!article.title && !article.html)) return;
  // 认出拿的是哪个框：万一页面上另有一份同 id 的占位元素，一眼就看得出来
  console.log("[DraftDepot] 51CTO 标题框：", titleInput.tagName,
    JSON.stringify(titleInput.getAttribute("placeholder")));

  // 灌标题正文这一整段都盖着遮罩：那期间页面是半截的，别让人插手（见 Mask.js）
  await DDMask.withMask(async () => {
    let titled = true;
    if (article.title) titled = await fillTitle(titleInput, article.title);
    // 字段叫 html，这一趟装的其实是 Markdown（见文件头）：图先传上去换成图床地址再灌进去。
    // 写完它自己会渲染预览、数"共多少字"，也会自动保存草稿——那是它自己的事
    if (article.html) setValue(textArea, await DDImages.uploadMarkdownImages(article.html, uploadImage));
    // 写正文必定带起一次渲染（见 fillTitle 的说明），所以正文之后标题还得再看一眼
    if (titled) await fillTitle(titleInput, article.title);
  });
  console.log("[DraftDepot] 文章已灌入 51CTO 编辑器，标题", titleInput.value ? "在位" : "没留住");
}, CHECK_INTERVAL);
