# 第三方声明 / Third-Party Notices

本文件收录本项目参考或依赖的第三方作品的版权声明与许可证文本。

This file records the copyright notices and license texts of third-party works
this project references or depends on.

---

## 1. @ggboy123/dsh-paper-reader

**用途**：本插件在实现方式上参考了该项目（工具声明的规整形态、右栏 tab 的注册方式、
pdf.js 的取用思路）。本仓库**未复制其源代码**；此处保留其完整版权声明与许可证文本，
以明确来源并符合 MIT 许可证的保留要求。

**Upstream**: https://github.com/GGboya/dsh-paper-reader
**Version referenced**: 1.7.0
**Author**: GGboya
**License**: MIT

以下为该项目 `LICENSE` 文件的完整原文（逐字保留，未作改动）：

```text
MIT License

Copyright (c) 2026 GGboya

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. pdf.js (pdfjs-dist)

**用途**：本插件在运行时用它渲染 PDF。

**分发方式**：作为 `dependencies` 由 npm 安装，**不随本仓库分发**。
本仓库的 `.gitignore` 排除了 `node_modules/`。

**Upstream**: https://github.com/mozilla/pdf.js
**License**: Apache-2.0

Apache-2.0 的 NOTICE 保留要求，在使用者安装依赖时由 npm 一并提供的
`node_modules/pdfjs-dist/LICENSE` 满足；若你需要把本插件与 pdf.js 一起再分发，
请自行保留该目录下的 `LICENSE` 文件。

完整文本见 https://www.apache.org/licenses/LICENSE-2.0
