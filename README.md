# dsh-compact

一个可安装到 DeepSeek Harness profile 的仓库外 Cordis 插件骨架。

## 当前内容

- TypeScript 严格模式源码与声明文件构建
- `dsh.bundle` 清单和 `cordis.patch.yml` 配置层
- Schemastery 配置校验及默认值
- 可逆的 Cordis 生命周期 effect 示例
- Vitest 生命周期测试
- 支持从 Git 仓库安装时自动构建的 `prepare` 脚本

当前插件只提供可选的加载、卸载诊断日志，默认关闭。后续功能应在 `src/index.ts` 中通过 Cordis service、event 或 effect 扩展，并保持所有注册可卸载。

## 开发

要求 Node.js `^22.19.0 || >=24.0.0` 和 pnpm 11。

```sh
pnpm install
pnpm run check
```

构建产物位于 `lib/`。

## 安装到 DSH profile

在该目录的上一级执行：

```sh
dsh plugin --profile compact-dev add ./dsh-compact
dsh --profile compact-dev --dump-config
```

配置层会插入以下插件条目：

```yaml
- id: dsh-compact
  name: dsh-compact
  config:
    logLifecycle: false
```

需要观察生命周期时，可在 profile 的 `cordis.patch.yml` 中覆盖完整配置并将 `logLifecycle` 改为 `true`。

卸载：

```sh
dsh plugin --profile compact-dev remove dsh-compact
```

## 目录结构

```text
src/index.ts       插件入口与配置
tests/             插件生命周期测试
cordis.patch.yml   安装到 profile 时应用的配置层
tsdown.config.ts   ESM 与类型声明构建
```
