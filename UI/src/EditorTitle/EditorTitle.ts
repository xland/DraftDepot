import "./EditorTitle.scss";
import html from "./EditorTitle.html?raw";
import CtrlBase from "../CtrlBase";
import Msg from "../Msg";
import EditorContent from "../EditorContent/EditorContent";
import toMarkdown from "../EditorContent/Markdown";

/**
 * 发布目标：按钮 title → 站点类型（存进 WindowSite.type）。
 * 不再带 URL：打开哪个地址由 native 按 type 决定（微信有 token 就直接进编辑页）。
 * 加平台只往这里加一条，native 不用改（但它的落地地址要进 WindowSite.cpp 的 siteHome）。
 */
const publishTargets = [
  { title: "发布到微信", type: "WeiXin" },
  { title: "发布到知乎", type: "ZhiHu" },
  { title: "发布到CSDN", type: "CSDN" },
  { title: "发布到博客园", type: "CnBlogs" },
  { title: "发布到开源中国", type: "OSC" },
  { title: "发布到掘金", type: "JueJin" },
  { title: "发布到InfoQ", type: "InfoQ" },
  { title: "发布到51CTO", type: "51CTO" },
  { title: "发布到阿里云开发者社区", type: "AliYun" },
];

/**
 * 富文本站点的正文改造都在对方页面上做。
 * 默认就给编辑器里的原始正文，站点脚本（JS/<站点>.js）在对方编辑页里按需收拾成那一站点要的形态：
 * 微信整段摊平成它自己的段落结构（JS/WeiXin.js 的 forWeiXin）、知乎给代码块标 Prism 的语言类名
 * （JS/ZhiHu.js 的 forZhiHu）。图片一律由站点脚本在对方编辑页里传图床（见各 JS/*.js）。
 * 加站点默认什么都不用登记。
 *
 * 例外是这几家 Markdown 编辑器：它们收的是 Markdown 文本而不是 HTML，所以整篇先在这里转一次
 * （见 Markdown）；InfoQ 虽然也是给 Markdown，但它是富文本编辑器，由站点脚本把整篇 Markdown 做成
 * .md 文件交给它自己的"导入 Markdown"，这样代码块的语言标识才不会丢（见 JS/InfoQ.js）。
 */
const markdownSites = new Set([
  // CSDN / 开源中国 / 博客园 / 掘金：写作页就是 Markdown 编辑器，直接给 Markdown
  "CSDN",
  "OSC",
  "CnBlogs",
  "JueJin",
  // InfoQ：给 Markdown，但入口是它自己的"导入 Markdown"文件（见 JS/InfoQ.js）
  "InfoQ",
  // 键引号：以数字开头的标识符不合法（站点 type 本身仍是字符串 "51CTO"）
  "51CTO",
  // 阿里云开发者社区：写文章页是 Markdown 源码编辑器（左边源码右边预览）
  "AliYun",
]);

/**
 * 编辑器顶部的文章标题栏（模块单例）。
 * 根元素 #editorTitle 由 ArticleEditor 挂到其顶部；
 * 左侧是标题输入框 #articleTitleInput，右侧是发布按钮 .publishBtn
 * （点击后把文章发布到外部平台：调 Msg.invoke("openSite", { type, title, html })，
 * type 决定开哪个 platform，title/html 是给对方编辑器用的当前文章内容）。
 */
class EditorTitle extends CtrlBase {
  constructor() {
    super(html);
  }

  /** 文章标题输入框：由 ArticleTitle 读写（载入文章时填标题，入库时取标题） */
  get input(): HTMLInputElement {
    return this.dom.querySelector<HTMLInputElement>("#articleTitleInput");
  }

  override ready(): void {
    // 标题一被改动就广播出去：由 ArticleTitle 写回当前选中的那篇（最多 2 秒一次）
    this.input.addEventListener("input", () => Msg.emit("articleTitleEdited"));
    // 输入框失焦：同上，但要求立刻写（理由见 EditorContent 的 focusout）
    this.input.addEventListener("blur", () => Msg.emit("editorBlur"));
    // 用 title 属性精确锁定按钮，避免依赖 HTML 里 8 个 .publishBtn 的顺序
    for (const target of publishTargets) {
      const btn = this.dom.querySelector<HTMLElement>(`.publishBtn[title="${target.title}"]`);
      // 只有 Markdown 站点要在这里转一手（见 markdownSites），其余站点的改造都在对方页面上做。
      // 转 Markdown 是同步的，这里一律 await 是为了将来换异步实现不用改调用处
      btn.addEventListener("click", async () => {
        const content = EditorContent.content;
        // 连同当前标题与正文一起交给 native：site 窗口里的脚本（如 WeiXin.js）进到对方编辑器后会来取。
        // 两个窗口是各自独立的 WebView2，互相看不见，内容只能靠 native 中转。
        // 大多数站点给原始正文，形态收拾由对方页面上的站点脚本做（见 markdownSites 的说明）
        Msg.invoke("openSite", {
          type: target.type,
          title: this.input.value,
          html: markdownSites.has(target.type) ? await toMarkdown(content) : content,
        });
      });
    }
  }
}

export default new EditorTitle();
