// 站点脚本（JS/*.js）共用的正文转换工具，注入时挂在 window.DDContent 上。
// 与 Msg.js 一样由 PageSite::injectSiteScript 拼在站点脚本前面，所以站点脚本里直接用 DDContent.xxx。
// 收在这里的东西得具备两个性质：
//   1. 多家都用得上——只一家用的（微信的段落摊平、CSDN 的 codesnippet 组件…）留在各家自己的脚本里；
//   2. 不依赖任何外部库——注入脚本是资源里的裸 JS，没有打包过程、不能 import。
//
// 代码语言表是唯一一处两边各存一份的东西：UI/src/CodeHighlight.ts 里有一份（那份带着色器），
// 这里一份——站点脚本只在收拾代码块结构时要判定语言与取名，用不到着色。改语言表时两边一起改。
(function () {
  /** 支持的语言：id 是 shiki 的语法名，也原样写在正文 code 的 data-lang 上 */
  const CODE_LANGS = [
    { id: "typescript", name: "TypeScript" },
    { id: "javascript", name: "JavaScript" },
    { id: "html", name: "HTML" },
    { id: "css", name: "CSS" },
    { id: "cpp", name: "C++" },
    { id: "c", name: "C" },
    { id: "python", name: "Python" },
    { id: "rust", name: "Rust" },
    { id: "go", name: "Go" },
    { id: "java", name: "Java" },
    { id: "sql", name: "SQL" },
    { id: "xml", name: "XML" },
  ];

  /** 字符串是不是支持的语言 id */
  function isCodeLang(value) {
    return CODE_LANGS.some(function (item) {
      return item.id === value;
    });
  }

  /** 语言 id → 显示名（typescript → TypeScript）；认不出时原样返回 */
  function langName(id) {
    const found = CODE_LANGS.find(function (item) {
      return item.id === id;
    });
    return found ? found.name : id;
  }

  /**
   * 遍历容器里所有"我们自己的代码块"：正文里的代码块存的是 <pre><code data-lang="x">纯文本</code></pre>，
   * data-lang 是编辑器自己打的标记。认不出语言的（老数据、手改过）不回调——各家都是"这种代码块
   * 原样留着"，交给对方当成没标语言的代码块。
   * cb(codeEl, lang)
   */
  function eachCode(root, cb) {
    for (const codeEl of Array.from(root.querySelectorAll("code[data-lang]"))) {
      const lang = codeEl.dataset.lang;
      if (!isCodeLang(lang)) continue;
      cb(codeEl, lang);
    }
  }

  /**
   * HTML 字符串 → 游离的根容器：把节点搬到一个临时 div 底下，改完取 root.innerHTML 就是加工后的正文。
   * 各家转换的第一步都是它，连 callbacks 之后的图片上传（DDImages.uploadImages）也是同一套解析，
   * 所以整个链路里 HTML 字符串会被反复解析几次——这些都是同步操作，比 DOM 状态传来传去省心
   */
  function parse(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const root = document.createElement("div");
    for (const child of Array.from(doc.body.childNodes)) {
      root.appendChild(document.importNode(child, true));
    }
    return root;
  }

  window.DDContent = {
    CODE_LANGS: CODE_LANGS,
    isCodeLang: isCodeLang,
    langName: langName,
    eachCode: eachCode,
    parse: parse,
  };
})();
