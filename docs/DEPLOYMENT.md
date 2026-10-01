# MS007 部署说明

这份文件主要用于灾难恢复和后续维护。日常使用不需要懂这里的命令。

## 目标

GitHub 的 main 分支是唯一主代码源。Cloudflare 只负责运行，不作为代码唯一保存位置。

## 首次部署需要的 Cloudflare 授权

GitHub 仓库 Actions Secrets 需要：
- CLOUDFLARE_API_TOKEN
- CLOUDFLARE_ACCOUNT_ID
- BOOTSTRAP_TOKEN

其中 BOOTSTRAP_TOKEN 只用于首次创建管理员账号，不是管理员登录密码。

配置完成后，GitHub Actions 会自动：
1. 查找 ms007-crm D1 数据库
2. 如果不存在则自动创建
3. 自动写入数据库结构
4. 自动部署 Worker 和前端静态文件
5. 自动设置首次初始化密钥

以后 main 分支代码更新会自动重新部署。

## 首次管理员

系统提供：
- GET /api/bootstrap-status
- POST /api/bootstrap

只有数据库中完全没有用户时才允许初始化管理员，并且必须携带正确的 x-bootstrap-token。

这样仓库中不保存任何默认管理员密码。

## 容量策略

针对约 10,000–20,000+ 纯文字客户：
- 客户列表服务端游标分页
- 默认每次 50 条
- 搜索在数据库端完成
- 常用字段建立索引
- 动态字段单独存储
- 进度百分比缓存到 customers
- 仪表盘不下载全部客户再统计
- 附件以后如需增加，应放对象存储，不写 Base64 进 D1

## 费用提醒

系统容量页会用中文显示服务商、容量、升级建议、参考费用和升级入口。
当前费用数字是配置数据，并保存最近核对日期；平台价格变化时只需要更新配置，不需要改整个系统。
