import { stripCodeBlocks, WRAPPER_SELECTOR } from "./CodeBlock";

/**
 * 代码块参与的复制，得由我们自己往剪贴板里写。
 *
 * 代码块在编辑器里是 rooster 的只读 entity——外壳写着 contenteditable="false"（见 CodeBlock.ts）。
 * Chromium 在 contenteditable 里复制时会把这种"不可编辑的子树"整块丢掉：Ctrl+A 全选再 Ctrl+C，
 * 粘出来只有正文，代码一行不剩（对着真实浏览器验过：Range.cloneContents 拿到的选区里明明有 <pre>，
 * 走一次真的 Ctrl+C 却没了）。
 *
 * 所以这里在 copy 时看一下选区里有没有代码块，有就自己写剪贴板：
 *   text/html：先把代码块还原成它入库时的形态 <pre><code data-lang>（stripCodeBlocks），
 *              粘到别处是干净的代码块，而不是 rooster 那一套脚手架；
 *   text/plain：按块拼出来的纯文本，代码块内部原本的换行留着。
 *
 * 选区里没有代码块就什么都不做：那种情况浏览器默认复制是对的，没必要插手。
 */

/** 块级标签：拼纯文本时要各占一行 */
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE",
  "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "OL", "P",
  "PRE", "SECTION", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);

/** 一个节点在纯文本里的样子：文本原样，pre 连同里头的换行原样，块级末尾补一个换行 */
function nodeText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as Element;
  // 代码块整个照搬：里头的换行就是这个样子，交给 <pre> 之外的规则改反而会把缩进弄坏
  if (el.tagName === "PRE") return (el.textContent ?? "") + "\n";
  if (el.tagName === "BR") return "\n";
  const inner = Array.from(el.childNodes).map(nodeText).join("");
  return BLOCK_TAGS.has(el.tagName) ? inner + "\n" : inner;
}

/** HTML → 纯文本：块与块之间换行，连续空行压成一个 */
function plainTextOf(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const text = Array.from(doc.body.childNodes).map(nodeText).join("");
  return text.replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function onCopy(event: ClipboardEvent): void {
  const selection = document.getSelection();
  const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  if (!range || range.collapsed || !event.clipboardData) return;

  // 浏览器 Ctrl+C 拷的那份在这儿就能拿到（选区里的代码块它是有的，只是默认那条路会把
  // contenteditable="false" 的子树丢掉），拿它当原材料自己写剪贴板
  const host = document.createElement("div");
  host.appendChild(range.cloneContents());
  if (!host.querySelector(WRAPPER_SELECTOR)) return; // 没有代码块：默认复制就是对的

  const html = stripCodeBlocks(host.innerHTML);
  event.clipboardData.setData("text/html", html);
  event.clipboardData.setData("text/plain", plainTextOf(html));
  event.preventDefault();
}

/** 在编辑器元素上挂上复制接管 */
export function installCopy(dom: HTMLElement): void {
  dom.addEventListener("copy", onCopy);
}
