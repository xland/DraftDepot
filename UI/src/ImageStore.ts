import Msg from "./Msg";

/** 正文里引用图片的主机前缀：原生把这个主机映射到了数据目录 */
const IMAGE_HOST_PREFIX = "https://app.localhost/";

/** 图片都存到数据目录的 images 子目录，正文里引用时的 URL 前缀 */
export const IMAGE_URL_PREFIX = IMAGE_HOST_PREFIX + "images/";

/** 原生给的图片目录句柄（数据目录下的 images），页面存活期间一直有效，取一次就够 */
let imageDir: FileSystemDirectoryHandle | null = null;

/**
 * 向原生要一次图片目录句柄：原生用 PostWebMessageAsJsonWithAdditionalObjects 把
 * File System Access 的目录句柄放进 additionalObjects 回过来，之后存文件全在 JS 侧完成。
 */
async function getImageDir(): Promise<FileSystemDirectoryHandle> {
  if (imageDir) return imageDir;
  const { objects } = await Msg.invokeWithObjects("getImageDir");
  const dir = objects[0];
  // 鸭子类型而不是 instanceof：句柄是原生注入的，认它有没有目录句柄的方法更稳
  if (!dir || typeof dir.getFileHandle !== "function") {
    throw new Error("未取到图片目录句柄");
  }
  imageDir = dir;
  return dir;
}

/** MIME 子类型 → 扩展名：image/png → .png，image/svg+xml → .svg，认不出就按 .png 存 */
export function extFromMime(mime: string): string {
  const sub = (mime || "").split("/")[1];
  return sub ? "." + sub.toLowerCase().replace("+xml", "") : ".png";
}

/** 扩展名：优先用原文件名后缀（jfif/webp 这类 MIME 不一定有），取不到再退回 MIME 子类型 */
export function extOfFile(file: File): string {
  const dot = file.name.lastIndexOf(".");
  if (dot > 0) return file.name.slice(dot).toLowerCase();
  return extFromMime(file.type);
}

/** data: URL 里的 MIME（data:image/png;base64,... → image/png），取不到给空串 */
export function mimeOfDataUrl(url: string): string {
  return /^data:([^;,]+)/.exec(url)?.[1] ?? "";
}

/**
 * 把图片写进图片目录，返回可持久引用的 https://app.localhost/images/<文件名>。
 * 不用 URL.createObjectURL：blob: 只对当前会话有效，写进正文 HTML 入库后重开文章就是裂图。
 */
export async function saveImage(blob: Blob, ext: string): Promise<string> {
  const dir = await getImageDir();
  const name = `img_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
  const fileHandle = await dir.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
  return IMAGE_URL_PREFIX + name;
}

/**
 * 正文里的图一律以 https://app.localhost/images/<文件名> 的形态入库与传递：
 * 对方站点取不到这个地址，所以发布时由站点脚本在对方编辑页里向 native 要图片目录句柄，
 * 按文件名取出文件传对方的图床，拿到地址再换掉正文里的 src
 * （见 JS/WeiXin.js、JS/ZhiHu.js、JS/CSDN.js、JS/OSC.js）。
 */
