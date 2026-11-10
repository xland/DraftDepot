# DraftDepot（稿仓）

<p align="center">
  <img src="./Doc/logo.png" width="128" alt="DraftDepot">
</p>

一款 Windows 桌面端多平台文章编辑与发布工具：本地优先，文章一键灌入各平台，代码块高亮自动适配，图片自动传对方图床。

## 特性

- 本地存储：数据目录 `%APPDATA%\DraftDepot`
- 富文本编辑器：基于 [roosterjs](https://github.com/microsoft/roosterjs)
- 代码块高亮：基于 [shiki](https://github.com/shikijs/shiki) 代码着色
- 图片即贴即存：粘贴或拖入的图像自动落盘到数据目录
- 自动保存：改动后 2 秒内入库
- 分类与文章管理：单层分类目录，右键新增/改名/删除；
- 单文件发行：一个 exe 独立运行，仅 3 MB

## 平台

- 微信公众号
- 知乎
- CSDN 
- 开源中国
- 博客园 
- 掘金 
- 51CTO 
- InfoQ 
- 阿里云开发者社区

## 下载

[下载最新版本](https://github.com/xland/DraftDepot/releases)

## 环境

- 运行环境：Windows 10/11 x64
- 依赖组件：WebView2 运行时 ≥ 115.0.1901.177（缺失或过旧时程序会弹窗引导下载）

## 数据

```text
%APPDATA%\DraftDepot\
├─ db.db      全部数据（SQLite）
├─ images\    正文引用的图片文件
├─ db.db.bak-*  分类目录升级前的整库备份（仅老库升级时生成）
└─ ...        WebView2 的用户数据目录也在这里
```

分类目录只有一层。从旧版（支持多级分类）升级时，程序首次启动会自动把子分类提升为顶层：
**不删任何分类、不改 id、不动文章的归属**，只把 `parent_id` 清成 NULL；同名分类除最早的一个外会加上 ` (id)` 后缀以便区分。
升级前会整库备份成 `db.db.bak-年-月-日-时`，升级包在事务里执行，失败会回滚且不影响程序继续使用。
等价的 SQL 脚本在 `DraftDepot/Db/migrate_flat_categories.sql`，一般无需手工执行；
需要回滚时把备份文件复制回 `db.db` 即可。

## 赞助

<table>
  <tr>
    <td align="center">
      <img alt="支付宝赞助" src="./Doc/alipay.jpg" width="160" height="160">
      <p>支付宝赞助</p>
    </td>
    <td align="center">
      <img alt="微信赞助" src="./Doc/wechat.png" width="160" height="160">
      <p>微信赞助</p>
    </td>
    <td align="center">
      <img alt="作者微信" src="./Doc/author.jpg" width="160" height="160">
      <p>作者微信</p>
    </td>
    <td align="center">
      <img alt="公众号二维码" src="./Doc/gongzhonghao.jpg" width="160" height="160">
      <p>公众号：桌面软件</p>
    </td>
  </tr>
</table>
