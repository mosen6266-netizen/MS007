# MS007 新账号准备清单

## 需要的新账号
- 新 Google 邮箱
- 新 ChatGPT（连接新 GitHub）
- 新 GitHub
- 新 Cloudflare
- Telegram 可继续使用原 Bot/群，也可另建；不是部署系统本身的必需账号

## GitHub
建议创建空仓库 `MS007`，默认分支 `main`。
上传恢复包中的全部文件，必须保留 `.github/`。

仓库 Settings -> Secrets and variables -> Actions 需要配置：
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `BOOTSTRAP_TOKEN`

不要把这些值写入代码、README、聊天或 V3 备份。

## Cloudflare
部署工作流会查找以下资源，不存在时自动创建：
- Production Worker: `ms007-crm`
- Production D1: `ms007-crm`
- Staging Worker: `ms007-crm-staging`
- Staging D1: `ms007-crm-staging`

新 Cloudflare 账号的 workers.dev 子域名候选值会根据新 CLOUDFLARE_ACCOUNT_ID 自动生成，不依赖旧账号。

## 首次管理员
`BOOTSTRAP_TOKEN` 不是登录密码，只保护“数据库完全没有用户时”的首次管理员创建。
若已有 V3，建议读取旧管理员 username，并用相同 username 创建新管理员，再设置新密码。

## 不放进 ZIP
- 当前生产客户数据 / 当前 D1
- V3 业务备份
- Cloudflare Account ID / API Token
- GitHub Token
- 管理员/业务员密码
- 登录 Session
- Bootstrap Token 值
- Telegram Bot Token
