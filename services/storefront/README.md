# GPTibo Go 后端

Go + Gin + PostgreSQL，API 与业务 Worker 使用同一个二进制。此版本仅面向全新安装；匿名化后的迁移与原部署不兼容，不导入生产快照。

## Docker 本地启动

需要 Docker Compose，命令在本目录执行。首先生成三个独立随机秘密（Python 3）：

```sh
python3 scripts/init-secrets.py
cp .env.example .env
docker compose config --quiet
docker compose build api
docker compose up -d --wait postgres
docker compose --profile maintenance run --rm maintenance migrate
docker compose --profile maintenance run --rm maintenance grant-runtime
docker compose up -d --wait api worker
```

也可以在 PowerShell 使用 `./scripts/init-secrets.ps1` 初始化。秘密文件位于被忽略的 `.secrets/`，已有文件不会覆盖。API 仅监听宿主机 `127.0.0.1:8093`，PostgreSQL 不映射宿主机端口；运行数据库角色与迁移所有者分离。

### 管理员与验证器

完成基础启动后，在**仓库根目录**执行 `npm run admin:setup`，按提示填写管理员用户名、收码邮箱和邮件方式。也可以传入参数：

```sh
# 本地开发，无需邮件服务账号，不向真实邮箱发信
npm run admin:setup -- --username dev-admin --email admin@example.invalid --mail local
```

命令保存后端 `.env`，生成独立随机 `.secrets/admin-totp`，并用 `compose.admin.yaml` 配置管理员身份、重启服务。已有验证器密钥保持不变。打开仓库根目录 `.admin-auth/setup.html`，使用验证器扫描二维码或手动录入密钥；页面与二维码均包含秘密，已被 Git 忽略，不要上传或分享。

访问 `http://127.0.0.1:5175/admin`，填写用户名并点击“获取验证码”。本地开发模式通过 `compose.dev-mail.yaml` 将验证码保存到私有 `.admin-auth/outbox/`；在根目录运行 `npm run admin:inbox` 查看最新管理员验证码，再与验证器当前 6 位验证码一起登录。验证码 10 分钟内有效，使用后失效。该模式仅接受本机 `PUBLIC_ORIGIN`，不启用交易或通知邮件，不能用于公开部署。

已有 Resend 时，将 API Key 保存到后端 `.secrets/resend-key`，再运行：

```sh
npm run admin:setup -- --username dev-admin --email admin@example.invalid --mail resend --mail-from 'GPTibo <noreply@example.invalid>'
```

将示例邮箱替换为自己的地址；发件地址需在 Resend 中完成验证。此模式叠加现有 `compose.auth.yaml`，启用真实邮件服务。`--mail none` 仅配置身份、暂不启用邮件登录；`--no-apply` 仅生成配置、不重启服务。程序不接收命令行 API Key，也不会打印验证器密钥。

后续从后端目录重启本地开发服务时，保留所选配置：

```sh
docker compose -f compose.yaml -f compose.admin.yaml -f compose.dev-mail.yaml up -d --wait api worker
# Resend 模式改用 compose.auth.yaml；也可在根目录再次运行 npm run admin:setup。
```

其他接入参数见 `.env.integrations.example`。复制为 `.env.integrations` 后可叠加 `compose.integrations.yaml`；所有开关默认关闭，匿名适配器的保留域名无法用于真实交易。必须先按自己的上游协议完成开发和测试，不能直接填生产秘密试运行。可选域名配置在 `compose.domains.yaml`，仅使用自己新建的云资源。

## 原生开发

程序读取环境变量，不自动加载 dotenv。通过 `DATABASE_URL_FILE` 或 `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD_FILE` 指向独立数据库；外部连接默认要求 TLS。先用所有者身份执行 `migrate` 和 `grant-runtime`，再用受限角色执行 `api` 和 `worker`：

```sh
go run ./cmd/storefront migrate
go run ./cmd/storefront grant-runtime
go run ./cmd/storefront api
# 另一个终端使用相同运行配置：
go run ./cmd/storefront worker
```

`grant-runtime` 还需 `APP_DB_PASSWORD_FILE`。运行身份需 `AUTH_SECRET_FILE`，默认公开来源为 `http://127.0.0.1:8093`。配置管理员与邮件后才能使用完整后台登录。根目录执行 `npx vite --config services/storefront/vite.config.ts` 启动前端。

## 测试

先在仓库根目录执行 `npm ci`；前后端路由契约测试需要 TypeScript 解析器。

```sh
go test ./...
go vet ./...
# 专用本机 PostgreSQL，库名必须以 _test 结尾：
STOREFRONT_TEST_DATABASE_URL='postgres://test_user:YOUR_LOCAL_PASSWORD@127.0.0.1:5432/storefront_test?sslmode=disable' go test -count=1 ./...
```

每个集成测试建立随机 schema 和受限角色，并在结束后清理，需要测试数据库所有者拥有创建角色权限。不可指向业务数据库；没有连接配置时，集成测试明确跳过。
