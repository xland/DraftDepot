import "./ArticleTitle.scss";
import html from "./ArticleTitle.html?raw";
import CtrlBase from "../CtrlBase";
import Msg from "../Msg";
import Header from "./Header/Header";
import Menu from "./Menu/Menu";
import EditorTitle from "../EditorTitle/EditorTitle";
import EditorContent from "../EditorContent/EditorContent";
import StatusBar from "../StatusBar/StatusBar";
import EmptyMask from "../ArticleEditor/EmptyMask/EmptyMask";

/** 原生侧返回的文章行 */
interface ArticleRow {
  id: number;
  title: string;
  /** 所属分类 id；未分类时为 null */
  categoryId: number | null;
  /** 更新时间，"YYYY-MM-DD HH:MM:SS"（本地时间，原生侧 datetime('now','localtime') 写的） */
  updatedAt: string;
  /** 正文 HTML：只有 getArticle / createArticle 这种按篇返回的接口带上，列表接口不带 */
  content?: string;
}

/** 没有标题的文章入库时用的占位标题；输入框本身保持为空 */
const UNTITLED = "【未命名】";

/**
 * 中部文章列表面板（模块单例）。
 * 面板即 #articleTitle 自身，由 ContentBox 挂到中间分栏槽位。
 * 内部先挂 Header 标题栏，再挂内容区（吃掉标题栏之外的高度并负责滚动），列表挂进内容区；
 * 启动时通过 Msg 请求原生侧读取文章标题并渲染成列表；
 * 选中分类后由 Category 调 setCategoryFilter()，只加载该分类名下的文章（单层目录，没有子分类），
 * 没选中任何分类则加载全部。这一版不做分页。
 *
 * 顺带管着"当前编辑的是哪一篇"：
 * - 列表每次重画完就选中第一行（列表按修改时间倒序，第一行就是最近改过的那篇），
 *   并把它的标题和正文载进编辑器；切分类就等于换一篇来编辑；
 * - 列表允许是空的：选中了没有文章的分类、或首次启动库里一篇都没有，此时没有"当前这篇"
 *   （编辑器清空、selectedId 为空），右侧编辑面板由 EmptyMask 盖住，中间只留一个「新建文章」按钮。
 * 换句话说没有"自动补一篇"：新建只有一条路，就是 addArticle
 * （清空标题输入框与正文 → 入库一篇【未命名】 → 插到列表最前面并选中它），
 * Header 上的加号和遮罩里的按钮都广播它。
 * 删除只有一条路：右键列表行 → 菜单里的"删除此文章"（删掉的就是右键命中的那篇）；
 * 删掉最后一篇之后同样按空列表处理：清空编辑器、盖遮罩。
 * 编辑过程中的改标题/改正文：立刻排队写回当前选中这篇（标题正文一起更新），排队期间最多 2 秒写一次；
 * 另外两个强制落库的点：标题输入框或正文失焦时立刻写一次（不等这 2 秒），关窗前再兜一次（见 flush）。
 */
class ArticleTitle extends CtrlBase {
  /** 当前过滤的分类 id；null 表示没选中分类，加载全部 */
  private categoryId: number | null = null;

  /** 列表容器：过滤条件变化时复用它，只换里面的行 */
  private list: HTMLElement | null = null;

  /** 标题栏之下的内容区：列表的滚动容器，高度 = 面板高度 - 标题栏 */
  private content: HTMLElement | null = null;

  /** 当前选中的列表行与它的 id：列表里永远有一篇被选中 */
  private selectedItem: HTMLElement | null = null;

  /** 当前选中文章的 id */
  private selectedId: number | null = null;

  /**
   * 正在程序化改动标题/正文（载入某篇时回填、新建后清空）：
   * 这期间 contentChanged 不是用户在编辑，别触发保存
   */
  private suppress = false;

  /** 防抖入库的定时器；0 = 没排着队 */
  private saveTimer = 0;

  /** 正在飞的那一轮写库（saveNow 的 Promise）；关窗前要等它落地，见 flush() */
  private savingNow: Promise<void> | null = null;

  /** 有待入库的改动（标题或正文改了还没写进去） */
  private dirty = false;

  /** updateArticle 正在往返的过程中：这期间的改动算下一轮 */
  private saving = false;

  /**
   * 两次入库之间的最小间隔（毫秒）。
   * 标题/正文一改就排队；连着打字也不会一个字一次 IO，而是每 2 秒写一次，
   * 写的时候取的是当下的最新内容，所以任何改动的落库延迟最多就是这 2 秒
   */
  private static readonly SAVE_INTERVAL = 2000;

  constructor() {
    super(html);
  }

  override ready(): void {
    Header.appendTo(this.dom);
    // 标题栏之后再补一层内容区：滚动条只落在它身上，标题栏永远在最上面不动
    this.content = document.createElement("div");
    this.content.className = "articleListContent";
    this.dom.appendChild(this.content);
    // 右键列表：整个内容区只挂一个监听，命中哪一行事后按 e.target 反查，不给每行单独绑
    this.content.addEventListener("contextmenu", (e) => this.onContextMenu(e));
    // 菜单里的"删除此文章"：删掉的就是被右键的那一行
    Menu.onRemove = (item) => void this.removeArticle(item);
    void this.loadAndRender();
    // 标题/正文的改动统一在这里收口写回当前选中的这篇
    Msg.on("articleTitleEdited", this.onEdited);
    Msg.on("editorContentChanged", this.onEdited);
    // 失焦 = 这一段编辑结束了：立刻落库，别让改动排在那 2 秒里等
    Msg.on("editorBlur", () => this.flushSave());
    // Header 上的加号：清空输入并新建一篇【未命名】
    Msg.on("addArticle", () => void this.createArticle());
  }

  /** 按分类过滤；传 null 表示取消过滤、加载全部。由 Category 在选中变化时调用 */
  setCategoryFilter(categoryId: number | null): void {
    if (this.categoryId === categoryId) return; // 还是同一个分类，不用重新请求
    this.categoryId = categoryId;
    void this.loadAndRender();
  }

  /** 请求原生侧读取文章标题，渲染成列表，再挑一篇选中并载进编辑器 */
  private async loadAndRender(): Promise<void> {
    const categoryId = this.categoryId;
    let rows: ArticleRow[] = [];
    try {
      const args = categoryId == null ? undefined : { categoryId };
      const data = await Msg.invoke("getArticleTitles", args);
      // 请求是异步的：回来时过滤条件可能已经变了，过期结果直接丢掉，避免列表闪回旧数据
      if (categoryId !== this.categoryId) return;
      rows = (data as { articles?: ArticleRow[] }).articles ?? [];
    } catch {
      // 读取失败：渲染空列表。空列表是正常状态、不是"补一篇"的理由，接下来按空处理：清空编辑器并盖遮罩
      rows = [];
    }
    this.renderList(rows);
    // 列表有了 → 选中第一行（同时把它的标题正文载进编辑器）；一篇都没有 → 清空编辑器 + 盖遮罩
    await this.ensureSelection();
    // 篇数可能刚变过（删掉一篇、或启动时空库补的那篇）：让状态栏重新数一次
    void StatusBar.refreshCounts();
  }

  /**
   * 列表重画完之后挑一篇选中：
   * 有文章就选第一行（列表按修改时间倒序，第一行就是最近改过的那篇，切换分类也就跟着换一篇）；
   * 一篇都没有就把编辑器腾空、交给遮罩。
   * 这里不再"补一篇【未命名】"：空列表是正常状态，新建只走 addArticle
   */
  private async ensureSelection(): Promise<void> {
    if (!this.list.childElementCount) {
      // 切走之前先把上一篇没落的改动写回它自己身上，再把编辑器腾空
      this.flushSave();
      this.clearSelection();
      return;
    }
    await this.select(this.list.firstElementChild as HTMLElement);
  }

  /**
   * 摘掉选中态、把编辑器腾空并盖住右侧面板：列表被过滤空了（切到空分类、删掉最后一篇）时用它。
   * 之后没有"当前这篇"，selectedId 为空，saveNow 也就不会拿 null 去写库；
   * 新建由遮罩里的「新建文章」按钮发起，建在当前分类下（没选分类就是未分类）
   */
  private clearSelection(): void {
    this.selectedItem?.classList.remove("selected");
    this.selectedItem = null;
    this.selectedId = null;
    this.dirty = false;
    // 清空是程序化改动，不算用户在编辑
    this.suppress = true;
    EditorTitle.input.value = "";
    EditorContent.setContent("");
    this.suppress = false;
    // 遮罩只是盖住、挡不住键盘：焦点留在标题框或正文里的话，打进去的字没有存处
    (document.activeElement as HTMLElement | null)?.blur();
    EmptyMask.setVisible(true);
    // 正文是程序化清空的，未必触发编辑事件，直接让状态栏重算一次字数
    StatusBar.updateWords();
  }

  private renderList(rows: ArticleRow[]): void {
    if (!this.content) return; // ready() 还没跑完（内容区还没建），先不渲染
    if (!this.list) {
      this.list = document.createElement("ul");
      this.list.className = "articleList";
      this.content.appendChild(this.list);
    }
    // 先清空：切换分类是重新请求重新渲染，不能往旧列表上叠
    this.list.replaceChildren();
    for (const row of rows) {
      this.list.appendChild(this.buildRow(row));
    }
    // 旧的行连同它们的选中样式已经被丢掉：selectedItem 指向的是不在文档里的节点，先置空。
    // selectedId 保留：列表还没选定新的一篇，这期间的编辑仍然属于原来那篇
    this.selectedItem = null;
  }

  /** 一行 = 标题（过长省略）+ 右侧更新时间；分类 id 挂在 dataset 上，点它就选中这篇 */
  private buildRow(row: ArticleRow): HTMLElement {
    const item = document.createElement("li");
    item.className = "articleItem";
    item.dataset.id = String(row.id);
    if (row.categoryId != null) item.dataset.categoryId = String(row.categoryId);

    const title = document.createElement("span");
    title.className = "articleItemTitle";
    title.textContent = row.title;
    // 标题被省略号截断时，悬停看全文
    title.title = row.title;

    const time = document.createElement("span");
    time.className = "articleItemTime";
    time.textContent = ArticleTitle.formatUpdatedAt(row.updatedAt);
    // 悬停看具体日期时间；原生侧给的就是完整时间串，直接拿来提示
    time.title = row.updatedAt;

    item.append(title, time);
    item.addEventListener("click", () => void this.select(item));
    return item;
  }

  /** 点一行（或列表重画后选中第一行）：戴上选中样式，并把这篇的标题与正文填进编辑器 */
  private async select(item: HTMLElement): Promise<void> {
    const id = Number(item.dataset.id);
    if (id === this.selectedId) {
      // 列表重画后行是新节点，样式得重新戴上；正文已经在编辑器里了，不用再取一次
      this.applySelection(item);
      return;
    }
    // 上一行还有没写完的改动：先落库到它自己身上，别串到这一篇来
    this.flushSave();
    this.applySelection(item);
    try {
      const data = (await Msg.invoke("getArticle", { id })) as { article: ArticleRow };
      // 请求是异步的：回来时用户可能已经又点了别的篇，过期结果直接丢掉
      if (this.selectedId !== id) return;
      EditorTitle.input.value = data.article.title;
      // 回填正文会触发 contentChanged，给它打上标记，别当成用户在改动
      this.suppress = true;
      EditorContent.setContent(data.article.content ?? "");
      this.suppress = false;
    } catch {
      // 读取失败：保持这一行选中，编辑器里的东西不动，用户再点一次即可重试
    }
  }

  /**
   * 切换选中态：摘掉旧的、给新的戴上，selectedId 跟着更新。
   * 这里是"有一篇被选中"的唯一收口，顺带把遮罩收起——有行可选就说明列表不是空的，
   * 编辑器该露出来（点列表行、切分类后选中第一行、新建，走的都是这里）
   */
  private applySelection(item: HTMLElement): void {
    this.selectedItem?.classList.remove("selected");
    this.selectedItem = item;
    this.selectedId = Number(item.dataset.id);
    item.classList.add("selected");
    EmptyMask.setVisible(false);
  }

  /** 标题或正文被改动：防抖写回当前选中的这一篇 */
  private readonly onEdited = (): void => {
    // 回填/清空是程序化改动，不算用户在编辑
    if (this.suppress) return;
    this.scheduleSave();
  };

  /** 新建一篇【未命名】：标题真写进库，输入框与正文清空，插到列表最上面并选中它 */
  private async createArticle(): Promise<void> {
    // 当前这篇还有没写完的改动：先落到它自己身上，别被新增的这篇接走
    this.flushSave();
    try {
      const data = (await Msg.invoke("createArticle", {
        title: UNTITLED,
        content: "",
        // 归到正在看的那个分类下；没选分类就是未分类
        categoryId: this.categoryId,
      })) as { article: ArticleRow };
      const item = this.buildRow(data.article);
      // 列表按修改时间倒序，刚建的这篇 updated_at 就是现在，必须排在最前面
      this.list.prepend(item);
      item.scrollIntoView({ block: "nearest" });
      this.applySelection(item);
      // 清空：这是新增动作本身，别当成用户在改这篇刚建好的文章
      this.suppress = true;
      EditorTitle.input.value = "";
      EditorContent.setContent("");
      this.suppress = false;
      // 新建不经过 loadAndRender，篇数得在这里单独刷一次
      void StatusBar.refreshCounts();
    } catch {
      // 入库失败：界面停在原来那篇上，用户可以再点一次加号重试
    }
  }

  /**
   * 右键列表：命不到行（右键空白处）就不接管，留给默认菜单；
   * 命到行就跟左键点这一行一样先选中它（这篇的标题正文载进编辑器），再在鼠标处弹出删除菜单
   * ——菜单里的"删除此文章"删的正是刚被选中这篇。
   */
  private onContextMenu(e: MouseEvent): void {
    const item = (e.target as HTMLElement).closest<HTMLElement>(".articleItem");
    if (!item) return;
    e.preventDefault();
    void this.select(item);
    Menu.open(e.clientX, e.clientY, item);
  }

  /**
   * 删除一篇：从库里删掉后重新请求列表、整片重画，由 ensureSelection 选中重画后的第一行。
   * 列表是按修改时间倒序取的，所以第一行就是剩下这些里最新改过的那篇；
   * 删到一篇都不剩，就按空列表处理：清空编辑器、盖遮罩（不再自动补一篇）。
   * 不问用户确认：删错的成本低于每次删都要点一下。
   */
  private async removeArticle(item: HTMLElement): Promise<void> {
    const id = Number(item.dataset.id);
    // 排着队的改动属于就要被删掉的那篇，没必要再写，直接丢掉
    this.cancelSave();
    try {
      const data = (await Msg.invoke("removeArticle", { id })) as { ok: boolean };
      if (!data.ok) return; // 库里已经没有这篇了：列表保持原样
    } catch {
      return; // 请求都走不通：列表保持原样，用户可以再试一次
    }
    await this.loadAndRender();
  }

  /** 有排着队的改动但不用写了（这篇就要被删掉）：停掉定时器，脏标记一并清掉 */
  private cancelSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    this.dirty = false;
  }

  /**
   * 标题或正文有改动：排队入库。
   * 已经排着队的就不管了——定时器到点时连同这几秒的改动一起写掉
   */
  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer || this.saving) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      void (this.savingNow = this.saveNow());
    }, ArticleTitle.SAVE_INTERVAL);
  }

  /** 把还没落的改动立刻写掉（切换文章、新建前调用，避免串稿） */
  private flushSave(): void {
    if (!this.dirty) return; // 没有待写的改动
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    void (this.savingNow = this.saveNow());
  }

  /**
   * 把还没落的改动立刻写完，并等它真正落地（关窗前调用）。
   * 与 flushSave 的区别是"等"：flushSave 发起了就不管，而窗口一关 WebView 就没了，
   * 飞在半路的 IPC 会被掐断，那几秒的编辑也就跟着没了——所以这里返回写库的 Promise，
   * 由调用方 await 完再关窗。
   */
  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    // 上一轮还在飞：先等它落地（它落地时若期间又有改动，dirty 会重新亮起来）
    if (this.savingNow) await this.savingNow;
    if (this.dirty) await (this.savingNow = this.saveNow());
    // 最后一轮的 finally 可能又排了一轮：进程要退了，不再排
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
  }

  private async saveNow(): Promise<void> {
    this.saveTimer = 0;
    // 没有选中的文章（列表被过滤空了、遮罩正盖着）：没有可以写回的地方，改动作废
    if (this.selectedId == null) {
      this.dirty = false;
      return;
    }
    this.saving = true;
    // 标题与正文一起写给当前选中的这篇：不管是哪个变了我们俩都存，省得判断来源。
    // 这一轮要写的东西已经取出来，写的过程中新来的改动算下一轮
    this.dirty = false;
    const id = this.selectedId;
    const title = ArticleTitle.storeTitle(EditorTitle.input.value);
    const content = EditorContent.content;
    const item = this.selectedItem;
    try {
      const data = (await Msg.invoke("updateArticle", { id, title, content })) as { updatedAt: string };
      // 写库的往返之间选中的可能已经不再是这一行（这篇被删了、或切了分类），
      // 那时 this.selectedItem 已经是别人，不能拿这篇的数据去改别人的行
      if (item !== this.selectedItem) return;
      // 列表行跟着更新：标题换成入库的值（空的会显示成【未命名】），时间换成库里新的 updated_at
      const titleEl = item.querySelector<HTMLElement>(".articleItemTitle");
      titleEl.textContent = title;
      titleEl.title = title;
      const timeEl = item.querySelector<HTMLElement>(".articleItemTime");
      timeEl.textContent = ArticleTitle.formatUpdatedAt(data.updatedAt);
      timeEl.title = data.updatedAt;
    } finally {
      this.saving = false;
      this.savingNow = null;
      // 写库期间又改了：再排一轮，下一次同样等 2 秒
      if (this.dirty) this.scheduleSave();
    }
  }

  /** 入库用的标题：输入框为空时用占位标题（输入框本身仍然保持为空） */
  private static storeTitle(value: string): string {
    return value.trim() || UNTITLED;
  }

  /**
   * 更新时间的显示规则：
   * 今天 → 今；昨天 → 昨；今年内 → MM-DD；更早（含去年）→ YY-MM-DD。
   * 只比日期不比时刻；格式不认识就原样显示，免得丢信息。
   */
  private static formatUpdatedAt(updatedAt: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(updatedAt);
    if (!match) return updatedAt;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    // 用本地零点构日期，只比较日期部分
    const date = new Date(year, month - 1, day);
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const days = Math.round((todayStart.getTime() - date.getTime()) / 86400000);
    if (days === 0) return "今";
    if (days === 1) return "昨";
    const monthDay = `${match[2]}-${match[3]}`;
    return year === now.getFullYear() ? monthDay : `${match[1].slice(2)}-${monthDay}`;
  }
}

export default new ArticleTitle();
