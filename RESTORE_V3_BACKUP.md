# 使用 V3 备份恢复业务数据

ZIP 负责恢复“程序”；V3 JSON 负责恢复“业务数据与非秘密配置”。

## V3 恢复内容
- 管理员/业务员账号元数据（不含密码）
- 客户
- 客户登记字段和值
- 客户进度定义与完成记录
- 左侧栏分类、按钮、映射
- 客户列表列设置
- 仪表盘组件设置
- systemSettings（含登记面板等系统配置）
- Telegram 非秘密设置
- Telegram 进度路由
- 操作记录
- Telegram 发送历史

## V3 故意不恢复
- 密码 hash/salt
- 登录 Session
- Bootstrap Token
- Telegram Bot Token
- Telegram 当前发送队列/限速内部状态
- Cloudflare/GitHub 凭据

## 正确顺序
1. 在旧系统尽可能临近迁移时间重新导出最新 V3。
2. 不要把 V3 提交到 GitHub。
3. 新系统部署成功并创建首次管理员。
4. 新系统 -> 管理员 -> 数据备份 -> 从备份恢复。
5. 选择 V3 JSON。
6. 先完整校验/预演；有冲突先处理，不强行写入。
7. 预演通过后正式恢复。
8. 等待派生搜索索引/进度维护任务完成。
9. 重新设置业务员密码并启用需要登录的账号。
10. 如启用 Telegram，重新填写 Bot Token 并测试。

## 管理员用户名建议
首次管理员创建前若能读取 V3，优先使用 V3 `users` 中 `role=admin` 的同一 `username` 和 `display_name`。
