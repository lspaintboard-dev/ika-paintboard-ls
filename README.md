# ika-paintboard

由 Ikaleio 开发的绘版后端，兼容 [LSP-Reforged](https://github.com/lspaintboard-dev/LSP-Reforged) API。

**部署方式：**

```bash
git clone https://github.com/Ikaleio/ika-paintboard.git
cd ika-paintboard
bun install
bun start
```

**开发方式：**

```bash
bun dev
```

`/dev/frontend` 上会启动一个功能齐全的前端。

Bun 开发服务器支持热重载。

**导入 LSP-Reforged 数据库 Token：**

将 LSP-Reforged 数据库放入工作文件夹并重命名为 `liucang.db`，程序运行时就会自动导入。

记得在导入完成后删掉旧数据库。
