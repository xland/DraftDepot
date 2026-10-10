import { createEntity } from "roosterjs-content-model-dom";
import { insertEntity } from "roosterjs-content-model-api";
import type { ContentModelBlock, ContentModelEntity, ContentModelParagraph, ReadonlyContentModelBlock, IEditor } from "roosterjs-content-model-types";
import { DEFAULT_LANG, highlightCode, isCodeLang, type CodeLangId } from "../CodeHighlight";

/**
 * 代码块在正文里的存取。
 *
 * roosterjs 9.59 没有"代码块"这个概念（只有行内 <code> 片段），直接把 <pre> 塞进去，
 * 下次它重写 DOM 时会把 pre 当成普通段落处理，缩进和换行会塌掉。
 * 所以代码块走 rooster 官方给"自定义块"的机制：**只读 entity**——
 * 外壳是 rooster 建的 div（带 _EType_CodeBlock），里面整个 pre 由我们自己渲染，rooster 不拆它。
 * 顺带得到两个好处：整块不可编辑（打字不会把着色颜色带走）、整块可一键删除。
 *
 * 进出编辑器各做一次转换：
 * - 进（setContent）：库里的 <pre><code data-lang> → 占位段落 → 模型里换成 entity + shiki 着色；
 * - 出（content）：entity → 只留纯文本与 data-lang 的 <pre><code>，着色样式不进库。
 */

/** entity 类型名；rooster 会在外壳上写 _EType_CodeBlock，靠它认代码块 */
const ENTITY_TYPE = "CodeBlock";

/** 编辑器里代码块外壳的选择器 */
const WRAPPER_SELECTOR = '[class*="_EType_CodeBlock"]';

/** 入库形态里的代码块：<pre><code data-lang="ts">纯文本</code></pre> */
const STORED_CODE_SELECTOR = "code[data-lang]";

/**
 * rooster 给块 entity 套的外层容器：里面除了真正的 entity，还有前后两个分隔符 span。
 * 这个类名会被 DOM→Model 的 knownElementProcessor 认出来按 entity 处理，
 * 所以入库时必须连它一起去掉、载入时也要连它一起换掉，否则库里（或载入路径上）
 * 残留的脚手架会让 rooster 把整块当成一个空 entity，代码就丢了。
 */
const ENTITY_CONTAINER_SELECTOR = '[class*="_E_EBlockEntityContainer"]';

/** 代码块底色：比正文白深一档，压掉 shiki 主题自带的白底 */
const CODE_BLOCK_BACKGROUND = "#f8f8f8";

/**
 * 载入时的占位文本：先作为普通段落进编辑器，随后在模型里整段换成 entity。
 * 只能用 HTML 里能原样存活的普通字符：HTML 解析会把 \u0000 换成 \uFFFD（规范要求的预处理），
 * 用它做标记的话，占位文本到模型里就被改写了，回头认不出来，代码块就丢了。
 */
const PLACEHOLDER_PREFIX = "@@DD_CODE_BLOCK_";

/** 造代码块元素：shiki 的主题色在 pre 的 style 上（背景 / 前景色），原样带过来 */
function buildPre(doc: Document, code: string, lang: CodeLangId): HTMLPreElement {
  const parsed = new DOMParser().parseFromString(highlightCode(code, lang), "text/html");
  const shikiPre = parsed.body.firstElementChild as HTMLPreElement;
  const pre = doc.createElement("pre");
  pre.className = "codeBlock";
  pre.dataset.lang = lang;
  pre.setAttribute("style", shikiPre.getAttribute("style") ?? "");
  // 代码块底色用比正文白再深一点的浅灰，跟正文区分开；shiki 主题给的白底盖掉
  pre.style.backgroundColor = CODE_BLOCK_BACKGROUND;
  pre.innerHTML = shikiPre.innerHTML;
  return pre;
}

/** 在光标处插入一个代码块（只读 entity） */
export function insertCodeBlock(editor: IEditor, code: string, lang: CodeLangId): void {
  insertEntity(editor, ENTITY_TYPE, true, "focus", {
    contentNode: buildPre(editor.getDocument(), code, lang),
    focusAfterEntity: true,
  });
}

/**
 * 改已有代码块：整块重建（着色重做）。
 * 先拍快照，让撤销能退回改之前；entity 内容是只读的，rooster 不会重写它，直接换掉即可。
 */
export function updateCodeBlock(editor: IEditor, wrapper: HTMLElement, code: string, lang: CodeLangId): void {
  editor.takeSnapshot();
  wrapper.replaceChildren(buildPre(editor.getDocument(), code, lang));
}

/** 从双击目标往上找代码块外壳；命不到返回 null */
export function findCodeBlock(target: Node | null): { wrapper: HTMLElement } | null {
  const el = target instanceof Element ? target : target?.parentElement;
  const wrapper = el?.closest<HTMLElement>(WRAPPER_SELECTOR);
  return wrapper ? { wrapper } : null;
}

/** 代码块里的原始代码与语言：shiki 产物的 textContent 就是原代码 */
export function codeOf(wrapper: HTMLElement): { code: string; lang: CodeLangId } {
  const lang = wrapper.querySelector<HTMLElement>("pre[data-lang]")?.dataset.lang;
  return {
    code: wrapper.querySelector<HTMLElement>("pre[data-lang]")?.textContent ?? "",
    lang: isCodeLang(lang) ? lang : DEFAULT_LANG,
  };
}

/** 正文（含着色样式）→ 入库形态：代码块只留纯文本与语言 */
export function stripCodeBlocks(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const wrapper of Array.from(doc.body.querySelectorAll<HTMLElement>(WRAPPER_SELECTOR))) {
    const { code, lang } = codeOf(wrapper);
    // 连外面的容器一起换：只换里层 wrapper 的话，rooster 的容器与分隔符会留在 HTML 里，
    // 下次载入时它会被当成一个空 entity，占位段落建不出来，代码块就丢了
    const container = wrapper.closest<HTMLElement>(ENTITY_CONTAINER_SELECTOR) ?? wrapper;
    container.replaceWith(buildStoredPre(doc, code, lang));
  }
  return doc.body.innerHTML;
}

/** 入库用的代码块：<pre><code data-lang="x">纯文本</code></pre> */
function buildStoredPre(doc: Document, code: string, lang: CodeLangId): HTMLElement {
  const pre = doc.createElement("pre");
  const codeEl = doc.createElement("code");
  codeEl.setAttribute("data-lang", lang);
  codeEl.textContent = code;
  pre.appendChild(codeEl);
  return pre;
}

/** 载入：把库里的代码块换成占位段落，返回剩下的干净 HTML 与各块的代码 / 语言 */
export function extractCodeBlocks(html: string): { html: string; blocks: { code: string; lang: CodeLangId }[] } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const blocks: { code: string; lang: CodeLangId }[] = [];
  for (const codeEl of Array.from(doc.body.querySelectorAll<HTMLElement>(STORED_CODE_SELECTOR))) {
    const lang = codeEl.dataset.lang;
    const placeholder = doc.createElement("div");
    placeholder.textContent = PLACEHOLDER_PREFIX + blocks.length;
    blocks.push({
      code: codeEl.textContent ?? "",
      lang: isCodeLang(lang) ? lang : DEFAULT_LANG,
    });
    // 占位必须落在正常文档流里：如果这段代码块还嵌在 rooster 的 entity 容器里（改这次之前
    // 存下的老数据就是），占位会被 rooster 连同容器一起当成 entity，段落就建不出来了
    const scope = codeEl.closest<HTMLElement>(ENTITY_CONTAINER_SELECTOR) ?? codeEl.parentElement ?? codeEl;
    scope.replaceWith(placeholder);
  }
  return { html: doc.body.innerHTML, blocks };
}

/** 正文已载入后：把占位段落换成真正的代码块 entity */
export function fillCodeBlocks(editor: IEditor, blocks: { code: string; lang: CodeLangId }[]): void {
  if (blocks.length === 0) return;
  const doc = editor.getDocument();
  editor.formatContentModel(
    (model, context) => {
      replacePlaceholders(model.blocks as ReadonlyContentModelBlock[], blocks, doc, context.newEntities);
      return true;
    },
    { apiName: "setCodeBlocks", skipDOMSelection: true },
  );
}

function replacePlaceholders(
  items: readonly ReadonlyContentModelBlock[],
  blocks: { code: string; lang: CodeLangId }[],
  doc: Document,
  newEntities: ContentModelEntity[],
): void {
  // formatContentModel 交出来的是 readonly 视图，但 rooster 就是要你就地改它
  // （改完由它按模型重写 DOM），所以这里转回可写类型
  const writable = items as ContentModelBlock[];
  for (let i = 0; i < writable.length; i++) {
    const item = writable[i];
    if (item.blockType === "Paragraph") {
      const index = placeholderIndex(item);
      if (index === null || !blocks[index]) continue;
      const wrapper = doc.createElement("div");
      wrapper.appendChild(buildPre(doc, blocks[index].code, blocks[index].lang));
      const entity = createEntity(wrapper, true, undefined, ENTITY_TYPE);
      writable[i] = entity;
      // 与官方 insertEntity 一致：登记到 newEntities，撤销快照才会带上这个 entity
      newEntities.push(entity);
    } else if (item.blockType === "BlockGroup") {
      replacePlaceholders(item.blocks, blocks, doc, newEntities);
    }
  }
}

/** 段落是不是占位：整段拼起来正好是一句占位文本才算 */
function placeholderIndex(block: ContentModelParagraph): number | null {
  const text = block.segments.map((segment) => (segment.segmentType === "Text" ? segment.text : "")).join("");
  const matched = new RegExp(`^${PLACEHOLDER_PREFIX}(\\d+)$`).exec(text);
  return matched ? Number(matched[1]) : null;
}

