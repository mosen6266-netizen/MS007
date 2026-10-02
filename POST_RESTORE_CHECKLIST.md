# MS007 新账号恢复后验收清单

- [ ] GitHub 默认分支是 main
- [ ] .github/workflows/deploy.yml 存在
- [ ] Quality Check 成功
- [ ] Deploy validate 成功
- [ ] Deploy staging 成功
- [ ] Deploy production 成功
- [ ] /api/health 显示 production 和当前 commit
- [ ] production D1 是新账号下的 ms007-crm
- [ ] 没有未应用 migrations
- [ ] 首页 / Logo / favicon 正常
- [ ] 管理员登录正常
- [ ] 业务员登录页正常
- [ ] V3 校验/预演成功
- [ ] V3 正式恢复成功
- [ ] 客户数量与备份一致
- [ ] 客户字段和值正常
- [ ] 客户进度及完成状态正常
- [ ] 业务员归属正常
- [ ] 左侧栏分类/按钮/顺序正常
- [ ] 客户列表设置正常
- [ ] 登记面板设置正常
- [ ] 仪表盘组件设置正常
- [ ] 回收站/归档状态符合备份
- [ ] 操作记录正常
- [ ] Telegram 非秘密配置/路由正常
- [ ] 业务员密码已重新设置，需要的账号已启用
- [ ] Telegram Bot Token（如使用）已重新填写
- [ ] Telegram 测试发送成功
- [ ] 新系统重新导出一份新的 V3 并安全保存

只有关键项全部通过，才把旧系统视为可以退役。
