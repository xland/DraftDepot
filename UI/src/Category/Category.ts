import "./Category.scss";
import html from "./Category.html?raw";
import CtrlBase from "../CtrlBase";
import Msg from "../Msg";
import Header from "./Header/Header";
import Menu from "./Menu/Menu";
import Editor from "./Editor/Editor";
import ArticleTitle from "../ArticleTitle/ArticleTitle";
import StatusBar from "../StatusBar/StatusBar";

/** 原生侧返回的分类行。parentId 恒为 null，只为兼容老协议保留，不再用来组树 */
interface CategoryRow {
  id: number;
  parentId: number | null;
  name: string;
}

/** 分类编辑器的打开方式：新增（顶层）或改名 */
type EditorMode = "add" | "rename";

/**
 * 左侧分类目录面板（模块单例）。目录只有一层。
 * 面板即 #category 自身，由 ContentBox 挂到分栏槽位。
 * 内部先挂 Header 标题栏，再挂内容区 #categoryContent（吃掉标题栏之外的高度并负责滚动）；
 * 启动时通过 Msg 请求原生侧从数据库读取分类，原样按一层平铺渲染成 ul/li，
 * 没有子分类、缩进、展开/折叠，也不再往 IPC 里传 parentId。
 * 点击名称选中/取消选中；右键弹 Menu 并顺手选中该分类；Menu 里的新增/改名走 Editor；
 * 删除只准删名下没有文章的分类，挡住时把原生给的原因弹给用户。
 */
class Category extends CtrlBase {
  /** 当前选中的分类行（.categoryLabel）；null 表示没有选中 */
  private selected: HTMLElement | null = null;

  /** 当前选中的分类 id：重画列表后靠它把选中还原回来 */
  private selectedId: number | null = null;

  /** 标题栏之下的内容区：分类列表的滚动容器，高度 = 面板高度 - 标题栏 */
  private content: HTMLElement | null = null;

  constructor() {
    super(html);
  }

  override ready(): void {
    Header.appendTo(this.dom);
    // 标题栏之后再补一层内容区：滚动条只落在它身上，标题栏永远在最上面不动
    this.content = document.createElement("div");
    this.content.className = "categoryContent";
    this.dom.appendChild(this.content);

    // 点击用事件委托：分类列表是异步渲染出来的，绑在节点上会漏掉后渲染的那些
    this.dom.addEventListener("click", (e) => {
      const label = (e.target as HTMLElement).closest<HTMLElement>(".categoryLabel");
      if (!label) {
        // 点面板空白处（含标题栏那块）：取消选中
        this.applySelection(null);
        return;
      }
      // 单层没有展开/折叠控件，点名称、图标或整片背景都算"选中/取消选中"
      this.applySelection(this.selected === label ? null : label);
    });

    // 右键分类节点：顺手把它选中，再弹菜单——菜单里的操作就以这个分类为目标
    this.dom.addEventListener("contextmenu", (e) => {
      const node = (e.target as HTMLElement).closest<HTMLLIElement>(".categoryNode");
      if (!node) return; // 右键面板空白处不接管，留给默认菜单
      e.preventDefault();
      // 只选中、不切换：右键已选中的分类不会把它取消掉
      this.applySelection(node.querySelector<HTMLElement>(":scope > .categoryLabel"));
      Menu.open(e.clientX, e.clientY, node);
    });

    // 标题栏右侧的加号：新增分类（弹层始终在按钮正下方）
    Header.onAddClick = (anchor) => this.openEditor(null, "add", anchor);

    // 右键菜单的动作：锚点是被右键的那个分类行（弹层贴在它下方，放不下向上翻折）
    Menu.onAction = (action, node, anchor) => {
      if (action === "add") this.openEditor(null, "add", anchor);
      else if (action === "rename") this.openEditor(node, "rename", anchor);
      else if (action === "remove") void this.removeCategory(node);
    };

    void this.loadAndRender();
  }

  /**
   * 打开分类编辑器（贴到触发它的锚点弹出）。
   * mode = add 时新建顶层分类（target 不用）；rename 时把 target 改成输入的名字。
   */
  private openEditor(
    target: HTMLElement | null,
    mode: EditorMode,
    anchor: { rect: DOMRect; mayFlip: boolean },
  ): void {
    const placeholder = mode === "add" ? "新分类名称" : "分类名称";
    Editor.open(anchor, { value: mode === "rename" ? Category.nameOf(target) : "", placeholder }, (result) => {
      // 传局部的 mode/target：请求期间用户可能又开了编辑器，字段会被改写
      void this.applyEditorResult(mode, target, result.name);
    });
  }

  /**
   * 提交分类编辑器：新增或改名，完成后重新加载列表，让界面立刻反映结果。
   * 注意"重新加载"这一步放在 try 外面且无条件执行：不管写入成功、失败还是原生侧没回应，
   * 都要重新拉一次分类——否则界面上看不到刚做的改动，也没法暴露真实状态。
   */
  private async applyEditorResult(mode: EditorMode, target: HTMLElement | null, name: string): Promise<void> {
    // 新增成功时用返回的 id 选中刚建好的分类
    let createdId: number | null = null;
    try {
      if (mode === "rename") {
        const id = Category.nodeIdOf(target);
        if (id != null) await Msg.invoke("renameCategory", { id, name });
      } else {
        // 单层：只带 name，不传 parentId（原生侧也会忽略它，一律建顶层）
        const data = (await Msg.invoke("addCategory", { name })) as { id?: number } | undefined;
        const newId = data?.id;
        if (typeof newId === "number" && newId > 0) createdId = newId;
      }
    } catch {
      // 请求失败（原生侧报错或没回应）也往下走，统一刷新
    }
    // 不指定 id 时选中会按原 id 还原，改名后视觉不跳
    await this.loadAndRender(createdId);
  }

  /**
   * 删除分类。只删名下没有文章的分类，原生侧会挡回被占用的并给一句原因，
   * 这里把原因弹给用户。
   */
  private async removeCategory(node: HTMLElement | null): Promise<void> {
    const id = Category.nodeIdOf(node);
    if (id == null) return;
    const name = Category.nameOf(node) || "该分类";
    // 用宿主浏览器的 confirm 弹窗；以后要做成应用内弹窗的话换掉这一句即可
    const confirmed = window.confirm(`删除分类「${name}」？`);
    if (!confirmed) return;

    try {
      const data = (await Msg.invoke("removeCategory", { id })) as { ok: boolean; reason?: string };
      // 挡回来的（有文章）与 id 不存在都走这里：把原生给的原因原样弹出来
      if (!data?.ok) window.alert(data?.reason || "删除失败");
    } catch {
      // 原生侧没回应（消息丢失）：没有原因可弹，直接刷新反映真实状态
    }
    await this.loadAndRender();
  }

  /** 切换选中态：先摘掉旧的，再给新的戴上；传 null 即全部取消选中 */
  private applySelection(label: HTMLElement | null): void {
    this.selected?.classList.remove("selected");
    this.selected = label;
    this.selected?.classList.add("selected");
    this.selectedId = Category.categoryIdOf(label);
    // 选中变化就通知文章列表按分类过滤；没选中任何分类时传 null，它会加载全部
    ArticleTitle.setCategoryFilter(this.selectedId);
  }

  /** 取分类行所属节点的 id；没有选中时返回 null */
  private static categoryIdOf(label: HTMLElement | null): number | null {
    const id = label?.closest<HTMLLIElement>(".categoryNode")?.dataset.id;
    return id ? Number(id) : null;
  }

  /** 取节点的分类 id */
  private static nodeIdOf(node: HTMLElement | null): number | null {
    const id = node?.dataset.id;
    return id ? Number(id) : null;
  }

  /** 取节点显示的名称（改名时用来预填输入框） */
  private static nameOf(node: HTMLElement | null): string {
    return node?.querySelector<HTMLElement>(":scope > .categoryLabel > .categoryName")?.textContent ?? "";
  }

  /** 请求原生侧读取分类并平铺渲染；selectId 指定重画后选中哪个分类 */
  private async loadAndRender(selectId: number | null = null): Promise<void> {
    try {
      const data = await Msg.invoke("getCategories");
      const rows: CategoryRow[] = (data as { categories?: CategoryRow[] }).categories ?? [];
      this.renderList(rows, selectId);
    } catch {
      // 读取失败时渲染空列表，避免阻塞其余面板
      this.renderList([], selectId);
    }
    // 分类数可能刚变过（新增/删除）：让状态栏重新数一次
    void StatusBar.refreshCounts();
  }

  /** 把分类原样渲染成一层列表，挂到 #category；selectId 用于指定重画后选中哪个分类 */
  private renderList(rows: CategoryRow[], selectId: number | null = null): void {
    // 新增/改名后是整表重建，先把旧列表摘掉，避免叠上去
    const content = this.content;
    if (!content) return;
    content.querySelector(".categoryTree")?.remove();
    // 旧节点已经离开文档，之前记的选中引用随之失效
    this.selected = null;

    const root = document.createElement("ul");
    root.className = "categoryTree";
    for (const row of rows) {
      root.appendChild(this.buildNode(row));
    }
    content.appendChild(root);

    // 选中还原：优先用调用方指定的 id（新建的分类），否则沿用原来的选中；
    // 分类已经不在了就取消选中
    const keepId = selectId ?? this.selectedId;
    if (keepId == null) {
      this.applySelection(null);
      return;
    }
    const label = this.dom.querySelector<HTMLElement>(`.categoryNode[data-id="${keepId}"] > .categoryLabel`);
    this.applySelection(label);
  }

  /** 构建单个分类节点（li）：图标位 + 名称，没有子树、没有展开/折叠 */
  private buildNode(row: CategoryRow): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "categoryNode";
    li.dataset.id = String(row.id);

    const label = document.createElement("div");
    label.className = "categoryLabel";

    // 固定的分类图标位：只是列表装饰，不再有展开/折叠语义（点它等同于点名称）
    const icon = document.createElement("i");
    icon.className = "icon categoryToggle icon-removeRect";
    label.appendChild(icon);

    const name = document.createElement("span");
    name.className = "categoryName";
    name.textContent = row.name;
    label.appendChild(name);
    li.appendChild(label);

    return li;
  }
}

export default new Category();
