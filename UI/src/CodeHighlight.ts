import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
// 语法与主题都按需静态导入（shiki 的 exports 把 shiki/langs/* 映射到 dist/langs/*，所以要带 .mjs）
import githubLight from "shiki/themes/github-light.mjs";
import c from "shiki/langs/c.mjs";
import cpp from "shiki/langs/cpp.mjs";
import csharp from "shiki/langs/csharp.mjs";
import css from "shiki/langs/css.mjs";
import go from "shiki/langs/go.mjs";
import html from "shiki/langs/html.mjs";
import java from "shiki/langs/java.mjs";
import javascript from "shiki/langs/javascript.mjs";
import python from "shiki/langs/python.mjs";
import rust from "shiki/langs/rust.mjs";
import sql from "shiki/langs/sql.mjs";
import typescript from "shiki/langs/typescript.mjs";
import xml from "shiki/langs/xml.mjs";

/**
 * 代码着色：只在"把代码放进正文"的两条路上用（插入/打开文章时的渲染、发布到微信时再着色一次）。
 *
 * 用 shiki 而不是 highlight.js / prismjs 的理由只有一个但足够：它产出的是**内联 style**
 * （<span style="color:#d73a49">），不依赖任何 CSS 文件。微信公众号会把 CSS 挡在外面，
 * 只有内联样式能跟着内容一起过去。hljs / prism 都是 class + 主题 CSS 的路子，到微信就掉色了。
 *
 * 同步构造（createHighlighterCoreSync + JS 正则引擎）：语法与主题都是静态导入的，
 * 引擎不用加载 wasm，所以不用 await——打开文章、点插入都能直接拿到着色结果。
 */

/** 主题：github-light，与正文白底协调 */
const THEME = "github-light";

/** 支持的语言：id 就是 shiki 的语法名，也原样写进正文的 data-lang */
export const CODE_LANGS = [
  { id: "typescript", name: "TypeScript" },
  { id: "javascript", name: "JavaScript" },
  { id: "html", name: "HTML" },
  { id: "css", name: "CSS" },
  { id: "cpp", name: "C++" },
  { id: "csharp", name: "C#" },
  { id: "c", name: "C" },
  { id: "python", name: "Python" },
  { id: "rust", name: "Rust" },
  { id: "go", name: "Go" },
  { id: "java", name: "Java" },
  { id: "sql", name: "SQL" },
  { id: "xml", name: "XML" },
] as const;

export type CodeLangId = (typeof CODE_LANGS)[number]["id"];

/** 认不出语言（老数据、手改过）时按它处理 */
export const DEFAULT_LANG: CodeLangId = "typescript";

const highlighter = createHighlighterCoreSync({
  themes: [githubLight],
  langs: [c, cpp, csharp, css, go, html, java, javascript, python, rust, sql, typescript, xml],
  engine: createJavaScriptRegexEngine(),
});

/** 代码 → 着色后的 HTML 字符串（<pre …><code><span style="color:…">…） */
export function highlightCode(code: string, lang: CodeLangId): string {
  return highlighter.codeToHtml(code, { lang, theme: THEME });
}

/** 字符串是不是支持的语言 id */
export function isCodeLang(value: string | undefined): value is CodeLangId {
  return CODE_LANGS.some((item) => item.id === value);
}

