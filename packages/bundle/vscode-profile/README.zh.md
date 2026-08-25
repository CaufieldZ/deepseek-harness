# @deepseek-ai/dsh-vscode-profile

[English](README.md) | 中文

`vscode` profile bundle：在 `dsh-web-app` 表面之上的 IDE 上下文 feed（[`dsh-vscode-context`](../../context/vscode-context/README.zh.md)）与 Claude Code 钩子桥（[`dsh-hooks-claude-code`](../../hooks/hooks-claude-code/README.zh.md)）。`dsh --profile vscode` 模板将其作为第三层组合在 `dsh-base` 与 `dsh-web-app` 之后：

```yaml
dsh:
  profile:
    bundles:
      - '@deepseek-ai/dsh-base'
      - '@deepseek-ai/dsh-web-app'
      - '@deepseek-ai/dsh-vscode-profile'
```

## patch 挂载的内容

| 行 | 包 | 配置 |
|---|---|---|
| `vscode-context` | `@deepseek-ai/dsh-vscode-context` | —（读取 `$DSH_HOME/vscode/context.json`） |
| `hooks-claude-code` | `@deepseek-ai/dsh-hooks-claude-code` | `configPath: ./.claude/settings.json` |

两行都追加在 web 表面之后的组合入口列表末尾。钩子配置路径相对子进程启动 cwd 解析：VS Code 扩展在工作区根启动子进程，因此工作区的 `.claude/settings.json`（或其 `hooks` 键）生效——与 Claude Code 读取的是同一个文件。没有该文件的工作区不注册任何钩子（桥记录警告后什么都不注册）。

## Model Experience

间接地通过插入的行生效：本 bundle 增加 IDE 上下文读取（token 与 KV-cache 影响见 vscode-context 包文档）与 CC 钩子桥，自身不贡献模型可见文本。

#### KV Cache 影响

无直接影响；每个插入行所属的包各自负责其影响。

## Known Limitations and Deferred Work

- **进程级钩子配置**——`hooks-claude-code` 在加载时读取一份配置；切换工作区需要重启子进程（`dsh: Restart Harness Child Process`）。
- **仅第一个工作区根**——feed 只列出第一个工作区文件夹；其余限制见 vscode-context 包。
