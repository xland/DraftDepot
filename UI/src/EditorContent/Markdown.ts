import { isCodeLang } from "../CodeHighlight";

/**
 * 把正文 HTML 转成 Markdown（只为"发布到 CSDN / 开源中国 / 博客园 / 掘金"这几条链路服务，
 * 不进库、不改编辑器内容）。这几家的写作页都是 Markdown 编辑器，所以不像微信/知乎那样给 HTML，
 * 而要给一段 Markdown 文本。
 *
 * 转换取"Markdown 能表达的那些语义"，具体取舍：
 *   1. 代码块 → 围栏（``` + 语言）。语言本来就在我们的 data-lang 上（见 CodeBlock.ts 的入库形态），
 *      直接抄进围栏就行，比从 class 里猜还准；
 *   2. 图片 → ![alt](src)，**src 原样保留** https://app.localhost/images/<文件名>：
 *      那是本程序 WebView2 的虚拟映射，对方的服务器取不到；站点脚本在对方写作页里向 native
 *      要一次图片目录句柄，按文件名取出文件传它的图床后再换掉地址（Markdown 正文的替换四家都一样，
 *      收在 Msg.js 的 uploadMarkdownImages 里）。宽高不用带：正文里的图已经是按排版
 *      尺寸缩放好的那一份，对方按原始尺寸显示就是我们调好的大小；
 *   3. 装饰性样式（文字色 / 背景色 / 字体 / 字号 / 行高 / 对齐）**一律丢掉**：Markdown 没这套语法，
 *      留着只能写成内联 HTML，而那边多半也不会认；
 *   4. 下划线与上/下标 → 保留成内联 HTML（<u> / <sup> / <sub>）：这几个在中文技术文里真会用到，
 *      GFM 普遍认内联 HTML，丢掉就真没了。
 *
 * 编辑器自己不产表格；粘贴进来的表格会退化成一段段纯文本（没有表头语法可言，勉强能读）。
 */

/** 块级标签：块与块之间空行隔开；不在表里的（span / a / b …）都归到行内 */
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIGURE", "FOOTER",
  "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "MAIN", "OL", "P", "PRE", "SECTION",
  "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);

/** 标题标签 → 层级（h1 → 1） */
const HEADING_LEVEL: Record<string, number> = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 };

/**
 * 文本转义：这些字符在 Markdown 里是语法，按字面出现就得转义，否则会被当成强调或链接。
 * 用反斜杠（CommonMark 的通用转义），不用 HTML 实体——实体在 Markdown 里也会被解码，但反斜杠更直观
 */
function escapeText(text: string): string {
  return text.replace(/[\\`*_[\]<>]/g, (c) => "\\" + c);
}

/** 一段文本里最长的一串反引号：围栏要比它长，代码才不会被自己截断 */
function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const matched of text.matchAll(/`+/g)) longest = Math.max(longest, matched[0].length);
  return longest;
}

/** 加强调记号：记号贴着文字，文字自带的首尾空白留在外面（** 贴着空格会失效） */
function wrap(marker: string, text: string): string {
  const lead = /^\s*/.exec(text)?.[0] ?? "";
  const trail = /\s*$/.exec(text)?.[0] ?? "";
  const core = text.slice(lead.length, text.length - trail.length);
  return core ? lead + marker + core + marker + trail : text;
}

/** 行内代码：围栏取"最长反引号串 + 1"；首尾是反引号时两侧补一个空格 */
function renderCodeSpan(text: string): string {
  const fence = "`".repeat(longestBacktickRun(text) + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return fence + pad + text + pad + fence;
}

/** 图片：![alt](src)；alt 里的方括号会撑破 Markdown 语法，去掉 */
function renderImage(el: Element): string {
  const src = el.getAttribute("src") ?? "";
  const alt = (el.getAttribute("alt") ?? "").replace(/[[\]]/g, "");
  return `![${alt}](${src})`;
}

/** 链接：地址里有空格或括号时套尖括号，否则 Markdown 会把后半截当成标题文字 */
function renderLink(el: Element): string {
  const href = el.getAttribute("href") ?? "";
  const text = renderInline(el);
  if (!href) return text;
  const target = /[\s()]/.test(href) ? `<${href}>` : href;
  return `[${text || href}](${target})`;
}

/** 行内内容：把一段节点摊平成一行 Markdown 文本（里面的 <br> 会变成换行） */
function renderInline(node: Node): string {
  let out = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += escapeText(child.textContent ?? "");
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    switch (el.tagName) {
      case "BR": // Markdown 的硬换行：行尾两个空格
        out += "  \n";
        break;
      case "IMG":
        out += renderImage(el);
        break;
      case "A":
        out += renderLink(el);
        break;
      case "CODE":
        out += renderCodeSpan(el.textContent ?? "");
        break;
      case "B":
      case "STRONG":
        out += wrap("**", renderInline(el));
        break;
      case "I":
      case "EM":
        out += wrap("*", renderInline(el));
        break;
      case "S":
      case "DEL":
      case "STRIKE":
        out += wrap("~~", renderInline(el));
        break;
      case "U": // Markdown 没有下划线语法，留内联 HTML
        out += `<u>${renderInline(el)}</u>`;
        break;
      case "SUP":
        out += `<sup>${renderInline(el)}</sup>`;
        break;
      case "SUB":
        out += `<sub>${renderInline(el)}</sub>`;
        break;
      default: // span / font 这类只带装饰样式的，与没见过的标签一样：只要里面的文字
        out += renderInline(el);
        break;
    }
  }
  return out;
}

/** 代码块：```<语言>\n代码\n```（语言取我们的 data-lang，认不出就不写） */
function renderCodeBlock(pre: Element): string[] {
  const code = pre.querySelector("code");
  const text = ((code ?? pre).textContent ?? "").replace(/\n+$/, "");
  const lang = (code as HTMLElement | null)?.dataset?.lang ?? "";
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  return [fence + (isCodeLang(lang) ? lang : ""), text, fence];
}

/**
 * 列表：子列表整体缩进"父项记号那么宽"（"- " 是 2、"1. " 是 3），
 * 这样它才被当成上一项的子列表，而不是另起一个列表
 */
function renderList(list: Element): string[] {
  const ordered = list.tagName === "OL";
  const lines: string[] = [];
  let index = 1;
  for (const li of Array.from(list.children).filter((child) => child.tagName === "LI")) {
    const marker = ordered ? `${index++}. ` : "- ";
    const indent = " ".repeat(marker.length);
    // 本项的内容：行内部分接在记号后面，块级部分（段落、引用、代码块）与子列表各占后续行
    const content: string[] = [];
    let head = "";
    const nested: Element[] = [];
    for (const child of Array.from(li.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        head += escapeText(child.textContent ?? "");
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        if (el.tagName === "UL" || el.tagName === "OL") nested.push(el);
        else if (BLOCK_TAGS.has(el.tagName)) content.push(...renderBlocks(el));
        else head += renderInline(el);
      }
    }
    if (head.trim()) content.unshift(head.trim());
    for (const sub of nested) content.push(...renderList(sub));
    if (!content.length) content.push("");
    lines.push(marker + content[0], ...content.slice(1).map((line) => indent + line));
  }
  return lines;
}

/** 块级内容 → 若干行（行与行之间由调用方决定怎么拼：正文块间空一行，列表项内不空行） */
function renderBlocks(node: Node): string[] {
  const lines: string[] = [];
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = escapeText(child.textContent ?? "").trim();
      if (text) lines.push(text);
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    const level = HEADING_LEVEL[el.tagName];
    if (level) {
      const text = renderInline(el).trim();
      if (text) lines.push(`${"#".repeat(level)} ${text}`);
    } else if (el.tagName === "BLOCKQUOTE") {
      // 引用里的每一行都要带 "> "（空行只带 ">"，不留尾空格），否则只有第一行算引用：
      // renderBlocks 出来的一项可能自己就是好几行（列表、代码块、<br> 造的硬换行），
      // 所以先按块拼好再拆成行，逐行加前缀——光给每项的第一行加，后面那些会掉出引用。
      // 块间要空行：挨着写的两行在 Markdown 里是同一段的软换行，渲染出来仍是一行，
      // 编辑器里明明是两行（引用里敲回车就是两个块），到这儿却并成了一句
      const inner = renderBlocks(el)
        .join("\n\n")
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"));
      if (inner.length) lines.push(inner.join("\n"));
    } else if (el.tagName === "UL" || el.tagName === "OL") {
      // 同理：一个列表是一个块，项与项之间只换行，不能空行（空行在 Markdown 里是"松散列表"，
      // 项内容会被包成段落，子列表的缩进也容易断）
      const items = renderList(el);
      if (items.length) lines.push(items.join("\n"));
    } else if (el.tagName === "PRE") {
      // 围栏三行是一整个块，绝不能拆开：拆了就变成 ``` 夹着一段正文
      lines.push(renderCodeBlock(el).join("\n"));
    } else if (el.tagName === "HR") {
      lines.push("---");
    } else if (hasBlockChild(el)) {
      // div 里还套着块（如粘贴进来的结构）：继续往下拆
      lines.push(...renderBlocks(el));
    } else {
      const text = renderInline(el).trim();
      if (text) lines.push(text); // 空段落不产出：否则正文里会多出一串空行
    }
  }
  return lines;
}

/** 里面还有块级子元素吗（有就继续递归，没有就当一段行内内容） */
function hasBlockChild(el: Element): boolean {
  return Array.from(el.children).some((child) => BLOCK_TAGS.has(child.tagName));
}

export default function toMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const lines = renderBlocks(doc.body).map((line) => line.trimEnd());
  // 块间空一行；连续空行压成一个（空段落与引用里的空行会攒出多余空行）
  return lines.join("\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
