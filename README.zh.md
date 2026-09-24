# dsh-claude-subscription

[English](README.md)

在 **DeepSeek Harness 里直接用你的 Claude Code 订阅**跑 Claude 模型 —— 不需要另买
Anthropic API key，也不按 token 计费。

你只需要用 `claude` CLI 登录一次。这个 bundle 会把这个凭证交给 harness 内置的
Anthropic 提供商，于是 DSH 和 CLI 共用同一份订阅。

## 你能得到什么

- **DSH 里用上 Claude 模型** —— Opus、Sonnet、Haiku，取决于你的套餐。
- **不用买、不用贴 API key。** 这台机器上 `claude` 能用，DSH 就能用。
- **保持登录。** token 在后台自动续期。
- **一份凭证，不是两份。** 续期会写回 CLI，所以 CLI 继续可用，你不用登录两次。
- **不打扰其他配置。** 其他 provider、默认模型、模型列表都不动。
- **任何 profile 都能装。**

## 前置条件

- **macOS。** 凭证从登录钥匙串读取。
- **Claude Code 订阅**（Pro / Max / Team），且至少登录过一次。
- 已安装 DSH，且 `claude` CLI 在 `PATH` 里。

## 安装

```sh
dsh plugin --profile web add github:dshapp/dsh-claude-subscription
```

或者从本地目录安装：

```sh
dsh plugin --profile web add /path/to/dsh-claude-subscription
```

然后**重启 harness** —— `dsh plugin` 只负责安装、不启动 profile，所以正在运行的
`dsh web` 还没加载它。

## 登录一次

如果这台机器上从没用过 CLI：

```sh
claude
```

完成浏览器登录即可。插件没有别的要配 —— 下次 harness 启动时会自己找到凭证，
Anthropic 路由随即可用。

## 选模型

`anthropic` 路由默认提供内置 catalog 里的**全部** Claude 模型，所以多数人不需要做
任何事：打开 **Models** 页面挑一个就行。

想用 catalog 里没有的模型（比如更新的版本），在 profile 的 `cordis.patch.yml` 里声明：

```yaml
- id: llm-pi-ai
  config:
    providers:
      anthropic:
        models:
          - id: claude-opus-5-5
            input:
              - text
              - image
```

> **注意：** 声明 `models` 会**整体替换该路由的 catalog**，而不是追加。只列一个
> 模型，这条路由就**只有**那一个模型。想同时保留 catalog 里的模型，要么把它们全列
> 出来，要么干脆不写这个字段、直接从 catalog 里选。

本 bundle 自己从不写 `models`，所以你在这里声明的内容会原样保留。

## 配置项

**没有配置项。** 订阅凭证只有一种合理的存放位置、一个引用名、一套续期节奏，所以本
bundle 直接写死，而不是暴露出「唯一正确取值就是默认值」的旋钮：

- 路由 `anthropic`，显示为 **anthropic**，解析 `ANTHROPIC_API_KEY`
- 凭证自动定位，续期自动写回
- 到期前自动续期，每 5 分钟重新检查一次
- 续期前的备份放在 `$DSH_HOME/claude-subscription`

想改任何一项，直接改 `lib/index.js` —— 常量都在文件顶部。

## 日常表现

- harness 启动后片刻，路由即可用。
- token 大约每 8 小时自动续期一次；插件每 5 分钟检查一次，只在确实需要时才动作。
- 长时间没开 harness？下次启动会自动续期，你不需要做什么。
- 用 `claude` 登录成了别的账号？下一次检查会采用新凭证。

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 日志出现 `no Claude Code credential …`，Anthropic 路由报错 | 这台机器还没登录。运行 `claude` 完成登录。 |
| Models 页面里找不到这条路由 | harness 安装后还没重新加载 bundle。重启它。 |
| `401` / "OAuth access token has been revoked" | 存储的 token 已失效。运行 `claude` 重新登录，下次检查会重新发布。 |
| `429 rate_limit_error` | 你套餐的速率限制，不是 bug。等一会儿，或换小一点的模型。 |
| 只能选到一个 Claude 模型 | 该路由声明了 `models` 列表，它会替换 catalog。见[选模型](#选模型)。 |
| DSH 用过之后 `claude` CLI 不能用了 | 两者共用一份凭证。用 `claude` 重新登录，DSH 会跟上。 |

## 卸载

```sh
dsh plugin --profile web remove dsh-claude-subscription
```

之后重启。你的 `claude` CLI 凭证不受影响 —— 想一并清除就用 `claude logout`。

## 说明

- **与 Anthropic 无关联。** 这是一个互操作性插件。它复用你已有的凭证，本身不授予
  任何访问权限。
- **你的订阅，你的条款。** 把订阅凭证共享给另一个客户端是你的选择，可能不完全符合
  Anthropic 的服务条款。请按"在自己机器上使用 CLI"的方式来使用它。
- **一份凭证，两个客户端。** DSH 和 `claude` 共用同一个登录会话，任何一边登出都会
  影响另一边。

## 开发

```sh
pnpm install
node test/credential.test.mjs
```

该测试需要一份有效的 `claude` 凭证才能描述；它只会写入一个临时钥匙串条目并在结束后
删除，且当解析到的不是该条目时会拒绝运行。

另有一个需要显式开启的实测，用来验证真实续期链路。它会消耗一次真实的一次性
refresh token，因此默认永不运行：

```sh
CLAUDE_LIVE_REFRESH_TEST=1 node test/refresh.live.mjs
```

## 许可证

[MIT](LICENSE)