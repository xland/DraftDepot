import { createButton } from "../../ToolbarButton";
import { clearFormat, getFormatState, toggleBlockQuote } from "roosterjs-content-model-api";
import type { ContentModelFormatContainerFormat } from "roosterjs-content-model-types";
import quoteSvg from "../icon/quote.svg?raw";

/**
 * 引用的格式：一律留空。
 * 引用长什么样（灰底 + 左侧框线 + 缩进 + 深灰文字）在 EditorContent.scss 里，
 * 作为 #editorContent blockquote 的默认样式，不写成内联 style——
 * 否则每段引用在入库的 HTML 里都挂着同一串重复 style，以后改样子还得回头洗数据。
 *
 * 这些键必须显式写：toggleBlockQuote 自带一套默认格式（margin 1em/40px、padding-left 10px…），
 * 不覆盖就会连 margin 一起写进 style。其中 margin 要传"官方给 blockquote 的默认值"：
 * rooster 拿它跟自己的隐式格式比，一样就判定"没改过"、不往元素上写，
 * 于是 HTML 里只剩下干净的 <blockquote>，缩进由 CSS 说了算。
 * 传 undefined 或空字符串都不行：那样它认为跟隐式格式不同，反而写一堆 margin: 0px 上去。
 */
const QUOTE_FORMAT: ContentModelFormatContainerFormat = {
  marginTop: "1em",
  marginBottom: "1em",
  marginLeft: "10px",
  marginRight: "10px",
  paddingTop: undefined,
  paddingRight: undefined,
  paddingBottom: undefined,
  paddingLeft: undefined,
  borderLeft: undefined,
  backgroundColor: undefined,
  textColor: undefined,
};

export const quoteButton = createButton({
  icon: quoteSvg,
  title: "引用",
  onClick: (editor) => {
    // 已在引用里：取消引用，不调 clearFormat——它会把 blockquote 容器拆开，
    // 导致 toggleBlockQuote 认不出"该取消引用"，反而又套一层
    if (getFormatState(editor).isBlockQuote) {
      toggleBlockQuote(editor, QUOTE_FORMAT);
      return;
    }
    // 套引用：先清除选中文本的所有样式（加粗、颜色、字号…），仅保留段落与换行，再套引用
    clearFormat(editor);
    toggleBlockQuote(editor, QUOTE_FORMAT);
  },
  isChecked: (state) => state.isBlockQuote === true,
});
