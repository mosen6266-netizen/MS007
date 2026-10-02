MS007 新账号终极恢复包
==========================

源系统版本：
ccc0b1d9dff530c2bf2f656df2a667c4e330f3b3

用途：
使用全新的 Google / ChatGPT / GitHub / Cloudflare 账号重新建立 MS007。

你还需要单独保存：
1. 旧 MS007 管理后台导出的最新 V3 业务备份 JSON。
2. Telegram Bot Token（如果继续使用 Telegram）。
3. 你自己的新账号登录信息。

恢复顺序：
1. 新 Google 邮箱注册 ChatGPT、GitHub、Cloudflare。
2. 新 GitHub 创建空仓库，建议仓库名 MS007，默认分支 main。
3. 将本恢复包文件夹里的全部内容上传到新仓库，必须保留 .github 文件夹。
4. 新 ChatGPT 连接新 GitHub。
5. 把 GPT_NEW_ACCOUNT_DEPLOYMENT_INSTRUCTION.txt 全文发给新 GPT。
6. 按 GPT 指引配置 GitHub Actions Secrets。
7. 部署空白新系统。
8. 首次管理员创建前，最好让 GPT 读取 V3 中 role=admin 的 username，并使用相同用户名创建新管理员；密码使用新的。
9. 登录新系统，导入 V3：先校验/预演，再正式恢复。
10. 重新设置业务员密码；如果使用 Telegram，重新填写 Bot Token。
11. 按 POST_RESTORE_CHECKLIST.md 验收。

注意：
- 客户与业务数据不包含在 ZIP 中，它们由 V3 恢复。
- 密码、Session、Bootstrap Token、Cloudflare Token、Telegram Bot Token 不包含在 ZIP 中。
- Worker/D1 名称保留 ms007-crm，以保持部署逻辑一致。
- 新 Cloudflare 的 workers.dev 地址会变化，这是正常的。
