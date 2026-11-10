import "./Menu.scss";
import html from "./Menu.html?raw";
import CtrlBase from "../../CtrlBase";

/**
 * 分类节点的右键菜单（模块单例）。
 * 平时不在 DOM 里：第一次 open() 时才把模板挂到 document.body
 * （不能挂在 #category 里，那个容器 overflow-y:auto 会把弹层裁掉），之后只切换 .open。
 * 三个菜单项按 data-action（add / rename / remove）报给 onAction，
 * 具体做什么由 Category 决定；选中态属于分类行（见 Category），菜单项本身只有 hover。
 * 单层目录没有"增加子级分类"这一项了。
 */
class Menu extends CtrlBase {
  /** 被右键的分类节点；将来增删分类要靠它定位（对外可读，方便后续接线） */
  target: HTMLElement | null = null;

  /** 菜单项被点击时的回调，由 Category 注册；带上被右键的节点和锚点
   *  （锚点是被右键的那个分类行 .categoryLabel 的包围盒，视口坐标，调用前已采集好） */
  onAction: ((action: string, target: HTMLElement | null, anchor: { rect: DOMRect; mayFlip: boolean }) => void) | null =
    null;

  /** 窗口失焦时收起菜单。定义成类字段而不是行内箭头函数：后者每次都是新引用，想解绑也解不掉 */
  private onWindowBlur = (): void => this.close();

  constructor() {
    super(html);
  }

  override ready(): void {
    // 菜单项统一用事件委托，动作本身交给调用方处理
    this.dom.addEventListener("click", (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
      if (!item) return;
      // 先收菜单再回调：回调里会弹编辑器，菜单不该还留在下面。
      // 锚点取被右键的那个分类行（.categoryLabel），不是被点的菜单项：
      // 编辑器要贴在分类正下方、与分类左对齐，菜单项只是触发它的入口。
      // 采集必须在 close() 之前——虽然分类行不受菜单显隐影响，
      // 但统一在关菜单前量好，避免回调期间布局变动导致量到的位置失真。
      // 万一没拿到分类行（理论上不会），退回用菜单项自己，保证弹层仍有锚点。
      const action = item.dataset.action ?? "";
      const target = this.target;
      const anchorEl = target?.querySelector<HTMLElement>(":scope > .categoryLabel") ?? item;
      const anchor = { rect: anchorEl.getBoundingClientRect(), mayFlip: true };
      this.close();
      this.onAction?.(action, target, anchor);
    });

    // 点空白、页面滚动、窗口失焦、Esc 都关闭
    document.addEventListener("mousedown", (e) => {
      // 首次 open() 之前还没挂到文档上，那时也没有菜单可关，close() 自己是空操作
      if (!this.dom?.contains(e.target as Node)) this.close();
    });
    // 用捕获：滚动可能发生在 #category 这个内层滚动容器上，scroll 不冒泡
    document.addEventListener("scroll", () => this.close(), true);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
    window.addEventListener("blur", this.onWindowBlur);
  }

  /** 在视口坐标 (x, y) 弹出菜单，target 是被右键的分类节点 */
  open(x: number, y: number, target: HTMLElement): void {
    this.target = target;
    if (!this.dom) {
      this.appendTo(document.body);
    }
    // 先显示再量尺寸：隐藏时量到的是 0，越界回收的判断会失效
    this.dom.classList.add("open");
    const { width, height } = this.dom.getBoundingClientRect();
    // 贴住鼠标位置，超出窗口就往回收，四周留 4px
    const left = Math.max(4, Math.min(x, window.innerWidth - width - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - height - 4));
    this.dom.style.left = `${left}px`;
    this.dom.style.top = `${top}px`;
  }

  close(): void {
    this.dom?.classList.remove("open");
  }
}

export default new Menu();
