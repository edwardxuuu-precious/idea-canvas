# 想法画布

在浏览器打开 [想法画布.html](想法画布.html) 即可离线使用。这份 HTML 同时是 Mac 桌面版和本机同步浏览器的界面源码。

## 构建 Mac 桌面版

在安装了 Xcode Command Line Tools 的 Mac 上，从项目目录运行下方命令。

```sh
./build.sh
```

签名后的 App 位于 `dist/想法画布.app`。Swift 源码、图标和应用配置位于 `macos/`。

## 查看画布和预览

桌面版和已配对的浏览器读写同一份本机数据，文件位于 `~/Library/Application Support/想法画布/画布数据.json`。从桌面版的「文件」菜单可以打开数据目录或复制浏览器同步链接。

离线 HTML 的编辑由打开它的浏览器保存。要把离线编辑带到另一处，在原画布的「文件」菜单导出可编辑 HTML 或 JSON。

本机项目的 `previews/` 有自动整理和图文编辑的界面预览。
