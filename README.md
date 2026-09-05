# commandcode-usage

Command Code（commandcode.ai）**多账号额度面板**，全量部署在 Cloudflare（Worker + D1）。
添加账号后随时查看每个账号的 **5 小时滚动 / 周窗口** 用量、剩余信用点与重置倒计时，
支持单个或全部刷新。

> 数据来自 `api.commandcode.ai` 的 `/alpha/*` 端点（未公开文档，解析层已防御性兼容字段变动）。

## 快速开始

### 一键部署（Cloudflare Worker + D1）

```bash
git clone <本仓库> && cd commandcode-usage
./deploy.sh        # 自动创建 D1、回填 database_id、部署
```

或手动三步：

```bash
npx wrangler login
npx wrangler d1 create commandcode-usage   # 把输出的 database_id 粘进 wrangler.toml
npx wrangler deploy
```

部署后 `https://xxx.workers.dev` 即是完整面板。
workers.dev 在部分地区被 DNS 污染不可达时，在 `wrangler.toml` 按注释加 `routes` 绑自有域名再部署一次。

### （推荐）给面板设管理密码

不设密码 = 任何人拿到链接都能看到你的账号额度。设一个管理密码后，打开页面是登录门，输对密码才能进入：

```bash
npx wrangler secret put ADMIN_TOKEN
```

- 密码只以 secret 形式存在你的 Worker 里（不进代码、不进 git）
- 登录后密码存浏览器 sessionStorage，关标签页即失效；面板右上角有「退出」
- 服务器端所有 `/api/*` 均校验该密码，密码比较为常数时间（防时序侧信道）

### 让 AI agent 帮你部署

把下面这段整段发给任何有终端权限的 AI agent（Claude Code、Codex 等）即可：

```text
请帮我部署 commandcode-usage（Command Code 多账号额度面板，Cloudflare Worker + D1 全栈）：

1. 克隆 https://github.com/MAXeaglet/commandcode-usage 并进入该目录
2. 运行 npx wrangler login 完成 Cloudflare 授权（会打开浏览器，需要我用 Cloudflare 账号登录确认）
3. 运行 ./deploy.sh —— 脚本会自动创建 D1 数据库 commandcode-usage、把 database_id 回填进 wrangler.toml、部署 Worker 和页面
4. 向我要一个管理密码（让我自己定，不要替我生成），然后执行 echo "我给的密码" | npx wrangler secret put ADMIN_TOKEN
5. 完成后把 workers.dev 访问地址告诉我，并说明：首次打开是登录门，输入刚才设置的密码即可进入面板添加 Command Code 账号

异常处理：
- 若 ./deploy.sh 报 wrangler d1 create 重名冲突，用 npx wrangler d1 list 找到现有库的 uuid，
  手动填入 wrangler.toml 的 database_id 字段后重新运行 ./deploy.sh
- 若 workers.dev 域名不可访问（部分地区被 DNS 污染），按 wrangler.toml 里注释的 routes 段
  帮我绑定自定义域名后重新部署
- 除上述 wrangler 命令外，不要改动任何源码文件
```
```

### 本地开发

```bash
python3 mock_server.py 18090 &      # 可选：离线模拟上游
npx wrangler dev                    # http://127.0.0.1:8787
```

`.dev.vars` 已默认把 `API_BASE` 指向本地 mock（`http://127.0.0.1:18090`）；
想直连真实上游，删掉 `.dev.vars` 里的 `API_BASE` 行即可。

## 工作原理

三个核心上游端点（均为 GET + `Authorization: Bearer <密钥>`）：

| 端点 | 数据 |
|------|------|
| `/alpha/whoami` | 账户身份、orgId |
| `/alpha/billing/credits` | 月度剩余 / 充值 / 免费信用 + `windowLimits.fiveHour` / `.weekly`（used/cap/exceeded/resetAt） |
| `/alpha/billing/subscriptions` | planId、状态、账期（`?orgId=` 取自 whoami） |

- **多账号**：账号存 D1 `accounts` 表（api_key + 备注 + 缓存用量 + 上次错误），添加时先向上游验证密钥有效性，重复密钥拒绝入库。
- 密钥明文存在**你自己的** D1 里（多账号面板的前提），除转发给 commandcode.ai 外不发给任何第三方；接口返回一律打码（`sk-…xxxx`）。
- 密钥被拒（401/403）在 whoami 即短路返回，不继续打其余端点；刷新失败保留旧缓存并记录 `lastError`。
- 套餐名由 planId 最长前缀匹配（`individual-pro-v1` 胜过 `individual-pro`）。
- 时间戳兼容 epoch 毫秒/秒与 ISO 字符串；窗口字段兼容 camelCase/snake_case 命名。
- 「全部刷新」受 Worker 子请求上限约束（免费版每请求 50 个，每账号 4 个上游调用），超过 12 个账号时仅刷新前 12 个并在页面提示。

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/login` | `{ password }` 校验管理密码（未设 `ADMIN_TOKEN` 时恒通过） |
| GET | `/api/accounts` | 账号列表（密钥打码，含缓存用量） |
| POST | `/api/accounts` | `{ key, label? }` 添加账号（先验证再入库） |
| PATCH | `/api/accounts/:id` | `{ label }` 改备注 |
| DELETE | `/api/accounts/:id` | 删除账号 |
| POST | `/api/refresh` | `{ id? }` 刷新一个（传 id）或全部（不传） |

设置 `ADMIN_TOKEN` 后除 `/api/login` 外均需带 `X-Admin-Token` 头。

## 文件

| 文件 | 说明 |
|------|------|
| `public/index.html` | 面板页面（零依赖单文件，多账号卡片 + 单个/全部刷新） |
| `worker.js` | Worker：账号 CRUD、上游聚合与防御性归一化、D1 读写 |
| `wrangler.toml` | Worker + 静态资源 + D1 绑定 |
| `deploy.sh` | 一键部署（建库、回填 id、deploy） |
| `mock_server.py` | 离线模拟上游（正常 / 5h 耗尽 / 部分失败 / snake_case / 垃圾响应 / 401） |

## License

MIT
