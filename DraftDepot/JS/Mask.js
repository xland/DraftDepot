// 站点脚本（JS/*.js）共用的遮罩提示，注入时挂在 window.DDMask 上。
// 与 Msg.js / Content.js 一样由 PageSite::injectSiteScript 拼在站点脚本前面，所以站点脚本里直接用 DDMask.xxx。
//
// 为什么要盖这一层：各站点脚本灌文章都是"传图 → 写标题 → 写正文"，中间要等网络、等编辑器消化内容，
// 那会儿页面看着是空的、内容是半截的，用户随手一点就可能把正在写的东西搅乱，或者以为还没开始就自己动手。
// 所以统一在这一层做：整页盖住 + 居中提示，灌完自动撤掉。
//
// 为什么单独一份：它既不是跟 native 说话（那是 Msg.js 的活儿），也不是收拾正文（那是 Content.js 的活儿），
// 是纯 UI。放在这里九个站点共用一份实现（各站点是各自的文档，各盖各的，互不影响）。
(function () {
  /** 默认提示语 */
  const MASK_TEXT = "正在同步文章，请稍后";
  // 转圈的动画：keyframes 只能写在样式表里，所以注入一次（带 id，重跑脚本时不会重复注入）
  const MASK_STYLE_ID = "dd-mask-style";
  const MASK_STYLE = "@keyframes dd-mask-spin{to{transform:rotate(360deg)}}";

  let maskEl = null;
  let maskDepth = 0; // 嵌套调用也只盖一层，最后一次 hideMask 才真撤
  let lastOverflow = ""; // 页面原来的滚动设置，撤遮罩时还原

  /** 动画样式表：第一次盖遮罩时才注入 */
  function ensureMaskStyle() {
    if (document.getElementById(MASK_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = MASK_STYLE_ID;
    style.textContent = MASK_STYLE;
    (document.head || document.documentElement).appendChild(style);
  }

  /** 遮罩上的输入一律拦掉：点击、滚轮、右键、触摸都到不了页面 */
  function blockEvent(ev) {
    ev.preventDefault();
    ev.stopPropagation();
  }

  /**
   * 盖一层遮罩：整页盖住，正中提示一句话。
   * 样式全写成内联：站点页面自己的 CSS 带不动它；z-index 取最大值，压过它自己的弹层。
   * 重复调用只是叠一层（嵌套只会盖一层），文案按最后一次给的显示
   */
  function showMask(text) {
    maskDepth += 1;
    if (maskEl) {
      const label = maskEl.querySelector(".dd-mask-text");
      if (label) label.textContent = text || MASK_TEXT;
      return;
    }
    // 脚本在文档创建时就跑，那会儿可能连 body 都还没有：这一拍先不盖，反正下一拍还会来
    const root = document.body || document.documentElement;
    if (!root) return;

    ensureMaskStyle();
    maskEl = document.createElement("div");
    Object.assign(maskEl.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "100%",
      height: "100%",
      zIndex: "2147483647",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "rgba(0, 0, 0, 0.45)",
      cursor: "wait",
      // 字体自己定死：不然会继承站点的字体与字号，各家看着都不一样
      fontSize: "15px",
      lineHeight: "1.5",
      fontFamily: "-apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif",
      color: "#fff",
    });
    const panel = document.createElement("div");
    Object.assign(panel.style, {
      display: "flex",
      alignItems: "center",
      padding: "16px 24px",
      borderRadius: "8px",
      background: "rgba(0, 0, 0, 0.75)",
      boxShadow: "0 4px 16px rgba(0, 0, 0, 0.35)",
    });
    const spinner = document.createElement("div");
    Object.assign(spinner.style, {
      width: "18px",
      height: "18px",
      marginRight: "12px",
      border: "2px solid rgba(255, 255, 255, 0.35)",
      borderTopColor: "#fff",
      borderRadius: "50%",
      animation: "dd-mask-spin 0.8s linear infinite",
    });
    const label = document.createElement("div");
    label.className = "dd-mask-text";
    label.textContent = text || MASK_TEXT;
    panel.appendChild(spinner);
    panel.appendChild(label);
    maskEl.appendChild(panel);
    root.appendChild(maskEl);

    // 交互全拦在遮罩这一层：页面自己的元素收不到点击、滚轮、右键、触摸
    const blocked = ["mousedown", "mouseup", "click", "dblclick", "wheel", "touchstart", "touchend", "contextmenu"];
    for (const type of blocked) {
      maskEl.addEventListener(type, blockEvent, true);
    }
    // 键盘拦在文档的捕获阶段：不然页面自己的快捷键与输入框照收不误
    document.addEventListener("keydown", blockEvent, true);
    // 顺带锁滚动：内容还半截的时候滚来滚去只会让人更摸不着头脑
    lastOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
  }

  /** 撤掉遮罩：嵌套着盖的（depth > 1）先不撤，等最外面那次 */
  function hideMask() {
    maskDepth = Math.max(0, maskDepth - 1);
    if (!maskEl || maskDepth > 0) return;
    document.removeEventListener("keydown", blockEvent, true);
    maskEl.remove();
    maskEl = null;
    document.documentElement.style.overflow = lastOverflow;
  }

  /**
   * 包一段活儿：盖遮罩 → 干活 → 撤遮罩（默认提示语见 MASK_TEXT，要换就传 text）。
   * 用 finally 撤：活儿里抛了错（比如某张图没传上去）也得把页面还给人家，不能卡在遮罩上
   */
  async function withMask(task, text) {
    try {
      showMask(text);
      return await task();
    } finally {
      hideMask();
    }
  }

  window.DDMask = {
    showMask: showMask,
    hideMask: hideMask,
    withMask: withMask,
  };
})();
