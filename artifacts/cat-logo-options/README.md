# CainFlow 猫头 Logo 候选

造型参照根目录`cainflow.ico`。四份独立SVG均使用`0 0 128 128`视口、透明背景和原生矢量路径，没有嵌入位图或外部字体。

| 编号 | 文件 | 方向 |
| --- | --- | --- |
| 1 | cat-01-familiar.svg | 原型精简：奶油色圆脸、粉耳鼻、三道胡须 |
| 2 | cat-02-solid.svg | 实心剪影：透明负形五官与胡须 |
| 3 | cat-03-outline.svg | 几何线稿：圆角轮廓、统一线条 |
| 4 | cat-04-flow.svg | 流线微笑：开放轮廓、弯眼、粉色点缀 |

`index.html`并排展示大尺寸以及22px浅/深顶栏效果；`preview.png`仅是这些真实SVG的浏览器渲染预览。下载链接指向SVG原文件。

2、3采用`currentColor`，4的轮廓也采用`currentColor`。集成时可内联SVG，或用`<svg viewBox="0 0 128 128"><use href="文件.svg#mark"/></svg>`继承当前主题文字色；独立`img`文档不会自动继承页面文字色。

2026-11-09用户选定方案3，已将同一矢量几何内联应用到APP顶栏，继承现有七主题配色。EXE图标仍保留原文件。preview.png为选型阶段的原始快照，对比页文字记录当前选择。
