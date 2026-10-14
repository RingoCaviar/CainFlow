# 对话工作台作为共享应用外壳中的并列视图

CainFlow 将对话工作台实现为画布编辑器的并列 Workspace mode，而不是 iframe、独立窗口或放大的 TextChat 节点。画布在模式切换时保持挂载，对话通过稳定 Workflow identity、共享执行服务和 Media asset 与画布协作；生产界面复用现有语义主题变量、按钮、面板、抽屉和交互规范。这样可以保留后台运行及画布视图状态，并防止对话模式形成重复的模型、媒体和主题体系。

Conversation 消息与 Media asset owner index 位于同一个 SQLite store；消息写入、完整目标引用建立及旧引用释放在一个数据库事务中提交。因此该聚合不存在 ADR-0008 所针对的“外部 Workflow 文档已提交、owner index 尚未提交”的跨持久化边界。Conversation 消息的终态不可变，待处理消息只允许单向进入终态；引用替换先建立全部新 owner，再于同一事务释放旧 owner。此同库原子事务是 ADR-0008 分阶段 transition protocol 的窄化特例，不适用于 Workflow 文档、文件或任何跨 store consumer；若 Conversation 存储日后拆分，必须改用完整 transition record、revision CAS 与 storage epoch fencing。
