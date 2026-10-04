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

/**
 * 行内内容里的一个节点：可能是裸文本，也可能是自带 Markdown 语义的行内元素。
 *
 * renderInline 是本系的入口（给它一个父节点，它把子节点摊平成一行），可有些场合手上本来就
 * 只有一个节点——renderBlocks 攒行内内容时遇到的正是这种：它逐个渲染兄弟节点再拼起来，
 * 若不经过这一层、直接拿 <img> 去喂 renderInline，渲染到的会是它的子节点（空的），图就没了
 */
function renderInlineNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeText(node.textContent ?? "");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as Element;
  switch (el.tagName) {
    case "BR": return "  \n"; // Markdown 的硬换行：行尾两个空格
    case "IMG": return renderImage(el);
    case "A": return renderLink(el);
    case "CODE": return renderCodeSpan(el.textContent ?? "");
    case "B":
    case "STRONG":
      return wrap("**", renderInline(el));
    case "I":
    case "EM":
      return wrap("*", renderInline(el));
    case "S":
    case "DEL":
    case "STRIKE":
      return wrap("~~", renderInline(el));
    case "U": return `<u>${renderInline(el)}</u>`; // Markdown 没有下划线语法，留内联 HTML
    case "SUP": return `<sup>${renderInline(el)}</sup>`;
    case "SUB": return `<sub>${renderInline(el)}</sub>`;
    // span / font 这类只带装饰样式的，与没见过的标签一样：只要里面的文字
    default: return renderInline(el);
  }
}

/** 行内内容：把一段节点的子节点摊平成一行 Markdown 文本（里面的 <br> 会变成换行） */
function renderInline(node: Node): string {
  let out = "";
  for (const child of Array.from(node.childNodes)) {
    out += renderInlineNode(child);
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
        // 同 renderBlocks：这里手上的也是一个孤零零的行内节点，
        // 喂给 renderInline 渲染到的是它的子节点——<li> 直属的链接会只剩下文字
        else head += renderInlineNode(el);
      }
    }
    if (head.trim()) content.unshift(head.trim());
    for (const sub of nested) content.push(...renderList(sub));
    if (!content.length) content.push("");
    lines.push(marker + content[0], ...content.slice(1).map((line) => indent + line));
  }
  return lines;
}

/**
 * 块级内容 → 若干行（行与行之间由调用方决定怎么拼：正文块间空一行，列表项内不空行）。
 *
 * 两条线的分工：块级子节点各自占行、自己决定里头怎么排（列表不空行、引用逐行加前缀、代码块整块）；
 * 其余的行内内容（裸文本、span / a / u / img …）一律攒起来，攒到遇见下一个块级子节点为止，
 * 攒出来的一整串才算一行。
 * 早先是每个子节点各 push 一行的：同一段里掺着的那些节点本来是一行上的东西
 * ——“文本 + 链接 + 文本”会被拆成三行，list item 里尤其明显，链接前后各断一下
 */
function renderBlocks(node: Node): string[] {
  const lines: string[] = [];
  let pending: string[] = []; // 攒着的行内内容
  const flush = () => {
    const text = pending.join("").trim();
    if (text) lines.push(text);
    pending = [];
  };
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      pending.push(escapeText(child.textContent ?? ""));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    const level = HEADING_LEVEL[el.tagName];
    if (level) {
      flush();
      const text = renderInline(el).trim();
      if (text) lines.push(`${"#".repeat(level)} ${text}`);
    } else if (el.tagName === "BLOCKQUOTE") {
      flush();
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
      flush();
      const items = renderList(el);
      if (items.length) lines.push(items.join("\n"));
    } else if (el.tagName === "PRE") {
      // 围栏三行是一整个块，绝不能拆开：拆了就变成 ``` 夹着一段正文
      flush();
      lines.push(renderCodeBlock(el).join("\n"));
    } else if (el.tagName === "HR") {
      flush();
      lines.push("---");
    } else if (BLOCK_TAGS.has(el.tagName)) {
      // DIV / P / TABLE 这些块自己就是一段：各自占自己那一行，别跟前后的邻居挤在一起
      flush();
      lines.push(...renderBlocks(el));
    } else {
      pending.push(renderInlineNode(el)); // 行内：并到同一段里，别占一行
    }
  }
  flush();
  return lines;
}

export default function toMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const lines = renderBlocks(doc.body).map((line) => line.trimEnd());
  // 块间空一行；连续空行压成一个（空段落与引用里的空行会攒出多余空行）
  return lines.join("\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
