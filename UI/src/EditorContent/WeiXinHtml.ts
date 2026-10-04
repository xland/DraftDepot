import { highlightCode, isCodeLang, type CodeLangId } from "../CodeHighlight";

/**
 * 微信公众号这条链路的正文改造暂时分成两半：
 *
 *   - 这里只做**代码块**：它是唯一没法下沉到站点脚本的一段（理由见下）；
 *   - 其余——把正文摊平成微信自己的段落结构——已经下沉到站点脚本 JS/WeiXin.js 的 forWeiXin，
 *     由它在对方编辑页里做完再灌进去。
 *
 * 为什么代码块必须在前端做完：着色**只能**靠 shiki。公众号会把外部 CSS 挡在外面，只有内联 style
 * 能跟着内容过去（见 CodeHighlight 的说明），所以 <span> 上的颜色得我们在产出 HTML 的时候就写上去。
 * 而站点脚本是嵌进 exe 资源里的一段裸 JS（`Resource.rc` 的 RCDATA，由 PageSite::injectSiteScript
 * 注入到对方页面），没有打包过程、不能 import，也就拿不到 shiki。
 *
 * 于是这里的产出必须是**最终形状**：微信自己"粘贴一段代码"生成的 code-snippet 结构：
 *
 *   <pre class="code-snippet code-snippet_nowrap" data-lang="ts">
 *     <code><span leaf="">…这一行…</span></code>   ← 一行一个 code
 *     …
 *   </pre>
 *
 * 这么转是为了解决长行被折断：我们自己怎么调 white-space 都没用（实测它会被改写成 pre-wrap，
 * 保留缩进但允许折行，于是内容总是先折行填满、永远不会溢出，overflow-x 也就白给）。
 * 而 code-snippet_nowrap 是它自己的类，"不折行"由它自己的样式表保证。
 * 着色仍然带内联 color（shiki 那份）：class 要靠它那边的样式表，内联是最稳的。
 * 字号 12px 与行高 1.6 写在每个 code 上（pre 不带任何样式）。
 *
 * 认不出语言的代码块原样留着。
 */

function buildWeiXinCodeBlock(code: string, lang: CodeLangId): HTMLElement {
  const parsed = new DOMParser().parseFromString(highlightCode(code, lang), "text/html");
  const shikiPre = parsed.body.firstElementChild;

  const pre = document.createElement("pre");
  // 容器一律不带内联样式：底色、内边距、滚动条这些交给它自己的 code-snippet 样式表，
  // 我们自己写的反而会盖掉它的规则。只保留类名（_nowrap 就是靠它的样式表做到不折行的）
  pre.className = "code-snippet code-snippet_nowrap";
  pre.dataset.lang = lang;

  // shiki 的每一行（<span class="line">）搬成一个 <code>，与它自己的结构一致
  for (const line of Array.from((shikiPre ?? parsed.body).querySelectorAll(".line"))) {
    const lineEl = document.createElement("code");
    // 一行一块：它的样式表里 pre > code 本来就是块级，写上更稳
    lineEl.style.display = "block";
    // 空行也要撑出一行的高度，否则几行空行会挤成一条
    lineEl.style.minHeight = "1.6em";
    // 字号与行高写在每行上：pre 上不给样式，这两条必须落在 code 上才有效
    lineEl.style.fontSize = "12px";
    lineEl.style.lineHeight = "1.6";
    const leaf = document.createElement("span");
    leaf.setAttribute("leaf", "");
    leaf.innerHTML = line.innerHTML; // 带 shiki 内联颜色的 token
    lineEl.appendChild(leaf);
    pre.appendChild(lineEl);
  }
  return pre;
}

/** 代码块换保持着色的最终形状：正文里存的是 <pre><code data-lang="ts">纯文本</code></pre> */
function highlightCodeBlocks(root: HTMLElement): void {
  for (const codeEl of Array.from(root.querySelectorAll<HTMLElement>("code[data-lang]"))) {
    const lang = codeEl.dataset.lang;
    if (!isCodeLang(lang)) continue;
    (codeEl.closest("pre") ?? codeEl).replaceWith(buildWeiXinCodeBlock(codeEl.textContent ?? "", lang));
  }
}

/** 原始正文 → 代码块已是微信最终形状的那一版；其余改造在 JS/WeiXin.js 里做 */
export default function forWeiXin(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const root = document.createElement("div");
  for (const child of Array.from(doc.body.childNodes)) {
    root.appendChild(document.importNode(child, true));
  }
  // 图片不动：src 原样留着，由站点脚本传图床（见 JS/WeiXin.js 的说明）
  highlightCodeBlocks(root);
  return root.innerHTML;
}
