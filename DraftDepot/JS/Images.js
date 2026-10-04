// 站点脚本（JS/*.js）共用的图片流水线，注入时挂在 window.DDImages 上。
// 与 Msg.js / Content.js 一样由 PageSite::injectSiteScript 拼在站点脚本前面，所以站点脚本里直接用 DDImages.xxx。
//
// 各站点脚本原本各写一份（要目录句柄 → 按名取文件 → 传图床 → 换地址），内容逐字相同，
// 收到这里共用一份：站点脚本只留自己家图床的 uploadImage（拿到 File，返回地址）。
//
// 为什么不留在 Msg.js：它虽然要跟 native 打交道（要目录句柄、问这张图传过没有），但主体是
// "取文件 → 传图床 → 记账 → 把地址换回正文"这一趟活儿，是业务；Msg.js 只留 JS ↔ C++ 的那一层。
// 为什么不进 Content.js：Content.js 收的是零依赖的正文转换函数（语言表、代码块遍历、HTML 解析），
// 塞进这一条要碰文件系统与网络的流水线，那份性质就没了。
//
// 传过就别再传：同一张图重发这一篇、或别的文章又用到它，发布前先拿文件名问一次 native
// （image_site 表，按"文件名 + 站点"记），命中直接用旧地址——省一趟上传，对方图床也不堆重复副本。
// 文件名是存图时一次性生成、之后从不改写的，所以同名必然是同一份内容，不会误命中。
(function () {
  /** 正文里引用图片的 URL 前缀：原生把这个主机映射到了数据目录的 images 子目录 */
  const IMAGE_URL_PREFIX = "https://app.localhost/images/";

  /** Markdown 正文里的图片地址：![](https://app.localhost/images/xxx.png) → 文件名那一截 */
  const MARKDOWN_IMAGE_PATTERN = /https:\/\/app\.localhost\/images\/([^)\s"']+)/g;

  /** 图片目录句柄（数据目录下的 images）：取一次就够；页面跳转后脚本重跑，缓存自然失效 */
  let imageDir = null;

  /** 向 native 要一次图片目录句柄：之后取文件全在 JS 侧完成，不用再为每张图往返一次 */
  async function getImageDir() {
    if (!imageDir) imageDir = (await DDMsg.invokeWithObjects("getImageDir")).objects[0];
    return imageDir;
  }

  /** 按文件名从图片目录里取文件：File 自带文件名与 MIME，正好能直接进 FormData */
  async function imageFile(name) {
    const dir = await getImageDir();
    return await (await dir.getFileHandle(name)).getFile();
  }

  /** 正文里的图：https://app.localhost/images/<文件名> → 文件名；不是这个前缀的（外链图）返回空串 */
  function fileNameOf(src) {
    return src.startsWith(IMAGE_URL_PREFIX) ? src.slice(IMAGE_URL_PREFIX.length) : "";
  }

  /**
   * 一张图在本站点的图床地址：
   * 先问 native 这张图传过没有，传过就直接拿地址；没有才取文件交给 uploadFile 上传，
   * 成功了把地址回写给 native——下一轮发布（重发、或别的文章用到同一张图）就不必再传。
   * uploadFile 由站点脚本给：拿到 File，返回图床地址。
   * 传失败不给地址，也不写库：下次会重新传
   */
  async function imageUrl(name, uploadFile) {
    const cached = await DDMsg.invoke("getImageUrl", { name: name });
    if (cached && cached.url) return cached.url;
    const url = await uploadFile(await imageFile(name));
    if (url) await DDMsg.invoke("setImageUrl", { name: name, url: url });
    return url;
  }

  /** 一张图上传失败不拦着整篇：多半是裂图，但不该为一张图把整篇都拦下 */
  function imageUrlOrEmpty(name, uploadFile) {
    return imageUrl(name, uploadFile).catch(function (err) {
      console.log("[DraftDepot] 图片上传失败", name, err);
      return "";
    });
  }

  /**
   * 把正文 HTML 里的图全部换成它在本站点图床上的地址（外链图取不到文件名，原样留着）。
   * 串行一张张来：图一般不多，省得并发把它限流了
   */
  async function uploadImages(html, uploadFile) {
    const root = DDContent.parse(html);
    for (const img of Array.from(root.querySelectorAll("img"))) {
      const name = fileNameOf(img.getAttribute("src") || "");
      if (!name) continue;
      const url = await imageUrlOrEmpty(name, uploadFile);
      if (url) img.setAttribute("src", url);
    }
    return root.innerHTML;
  }

  /**
   * 同上，但正文是 Markdown 文本（OSC / 博客园 / 掘金 / CSDN 这几家的写作页收的是 Markdown 而不是 HTML）：
   * 按同样的前缀认出文件名，传成图床地址后再把整段前缀就地替换掉
   */
  async function uploadMarkdownImages(text, uploadFile) {
    if (!text.includes(IMAGE_URL_PREFIX)) return text;
    // 同一张图可能在正文里出现多次：去重，只处理一次
    const names = [...new Set([...text.matchAll(MARKDOWN_IMAGE_PATTERN)].map((matched) => matched[1]))];
    let result = text;
    for (const name of names) {
      const url = await imageUrlOrEmpty(name, uploadFile);
      if (!url) continue;
      result = result.split(IMAGE_URL_PREFIX + name).join(url);
    }
    return result;
  }

  window.DDImages = {
    imageFile: imageFile,
    imageUrl: imageUrl,
    uploadImages: uploadImages,
    uploadMarkdownImages: uploadMarkdownImages,
  };
})();
