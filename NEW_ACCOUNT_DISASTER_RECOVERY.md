# MS007 新账号灾难恢复

源系统 commit: `ccc0b1d9dff530c2bf2f656df2a667c4e330f3b3`

代码/结构来自恢复 ZIP；客户和业务数据来自单独导出的 V3。

## 全新账号恢复
1. 新 Google -> 新 ChatGPT / GitHub / Cloudflare。
2. 新 GitHub 建空仓库并上传恢复包全部文件。
3. GitHub Actions Secrets 配置 Cloudflare 授权和新的 Bootstrap Token。
4. Deploy 工作流自动创建全新 D1、初始化 schema、应用 migrations、部署 Worker/静态资源。
5. 首次管理员建议使用 V3 中旧管理员相同 username。
6. 登录后用 V3 预演并恢复业务数据。
7. 重设密码和 Telegram Bot Token。
8. 按 POST_RESTORE_CHECKLIST.md 验收。

## 数据安全
已有 D1 不能为了重新部署而删除、重建或用 schema.sql 覆盖。
schema.sql 只用于全新空数据库；已有数据库只使用 migrations/。
