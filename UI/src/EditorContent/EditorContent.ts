import "./EditorContent.scss";
import html from "./EditorContent.html?raw";
import CtrlBase from "../CtrlBase";
import { Editor, createModelFromHtml, exportContent } from "roosterjs-content-model-core";
import Msg from "../Msg";
import { extractCodeBlocks, fillCodeBlocks, findCodeBlock, stripCodeBlocks } from "./CodeBlock";
import { EditPlugin, HyperlinkPlugin, ImageEditPlugin, PastePlugin, ShortcutPlugin, WatermarkPlugin } from "roosterjs";
import EditorPlugin from "./EditorPlugin";
import ImagePlugin from "./ImagePlugin";

class EditorContent extends CtrlBase {
  editor: Editor | null = null;
  private imagePlugin = new ImagePlugin();

  constructor() {
    super(html);
  }

  override ready(): void {
    this.editor = new Editor(this.dom as HTMLDivElement, {
      plugins: [
        new WatermarkPlugin("请输入文章内容…"),
        // 官方 createEditor 默认三件套：Paste 负责粘贴清理，Edit 负责 Backspace/Delete/Tab/Enter
        // 的 Content Model 编辑（引用内空行回车跳出即由其中的 deleteEmptyQuote 提供）
        new PastePlugin(),
        new EditPlugin(),
        // 对标官方 demo：hover 显示链接地址、Ctrl+Click 打开链接、输入文本与 url 一致时同步 href
        new HyperlinkPlugin(),
        // 对标官方 demo：点击图片出现拖拽手柄，可拉伸缩放。
        // 官方默认 onSelectState 为 resize + rotate，这里按需求只保留缩放（不旋转）
        new ImageEditPlugin({ disableRotate: true }),
        // 对标官方 demo：Ctrl+B/I/U、Ctrl+Z/Y、Ctrl+Shift+7/8 等快捷键
        new ShortcutPlugin(),
        // 粘贴/拖放进来的内联图片（base64）落盘换持久 URL
        this.imagePlugin,
        new EditorPlugin(),
      ],
      // 剪贴板上没有 HTML（复制来的是纯文本）时按纯文本粘，别走默认的 normal。
      // normal 那一路 roosterjs 会硬给每个文本段塞一个 textColor = rgb(0,0,0)
      // （见它 paste/mergePasteContent 的 getSegmentFormatForPaste），出 DOM 时每段文本都要建一个
      // span 才写得下这个颜色，于是纯文本平白被包成 <span style="color: rgb(0, 0, 0);">。
      // 换成 asPlainText 就不走那一段，段格式是空的，那个没有属性的 span 会被它自己优化掉，
      // 粘进来的就是纯文本。有 HTML 的照旧按原格式粘（Word/网页复制来的那些还需要它）
      defaultPasteType: (_doc, clipboardData) => (clipboardData.rawHtml ? "normal" : "asPlainText"),
      // 不设 defaultSegmentFormat：默认字体/字号/颜色交给 #editorContent 的 CSS（见 EditorContent.scss）。
      // 设了它反而有害——roosterjs 的 FormatPlugin 会在每次输入时把默认格式刷成段落上的内联 style，
      // 于是每段都挂着同一串 style，还会盖掉 CSS 里的颜色；只有用户手动改过的样式才该写进 HTML
    });
    // 双击代码块 → 交给工具栏的 Code 弹层编辑；代码块是只读 entity，双击不会进文本编辑态
    this.dom.addEventListener("dblclick", (e) => {
      const found = findCodeBlock(e.target as Node);
      if (found) Msg.emit("editCodeBlock", found);
    });
    // 失焦（点到分类树、工具栏、关窗按钮）就立刻落库：只靠那 2 秒防抖的话，
    // 失焦后紧接着关掉程序，最后这点改动就随窗口一起没了
    this.dom.addEventListener("focusout", () => Msg.emit("editorBlur"));
  }

  /** 当前正文的 HTML：入库就是取它。代码块在这里剥掉着色，只留纯文本与语言 */
  get content(): string {
    const html = stripCodeBlocks(exportContent(this.editor));
    // roosterjs 导出时会把浏览器默认色 rgb(0, 0, 0) 写到每段 div 的 style 上，
    // 既多余又盖掉 CSS 里的 #333333；剥掉它，颜色回归 CSS
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const el of Array.from(doc.body.querySelectorAll<HTMLElement>("[style]"))) {
      const style = el.getAttribute("style") ?? "";
      const cleaned = style.replace(/color:\s*rgb\(0,\s*0,\s*0\)\s*;?/gi, "").trim();
      if (cleaned) el.setAttribute("style", cleaned);
      else el.removeAttribute("style");
    }
    return doc.body.innerHTML;
  }

  /**
   * 把 HTML 写进编辑器（打开某篇文章时回填正文）。
   * roosterjs 没有 setContentModel，只能借 formatContentModel：在回调里把模型的内容块整体换掉，
   * 返回 true 表示模型已改动、需要写回 DOM。skipDOMSelection 是不给它安插选区（没人在这时候打字）。
   * 库里的代码块先抽成占位段落，正文进去之后再由 fillCodeBlocks 换成着色的 entity。
   */
  setContent(html: string): void {
    const { html: plain, blocks } = extractCodeBlocks(html);
    this.editor.formatContentModel(
      (model) => {
        model.blocks = createModelFromHtml(plain).blocks;
        return true;
      },
      { apiName: "setContent", skipDOMSelection: true },
    );
    fillCodeBlocks(this.editor, blocks);
  }
}

export default new EditorContent();
