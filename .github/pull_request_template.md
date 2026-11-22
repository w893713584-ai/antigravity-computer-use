<!-- 中文 / English 任选其一填写即可 / Fill in either language -->
<!-- 提交前请先阅读 CONTRIBUTING.md / Please read CONTRIBUTING.md first -->

## 改动说明 / What this PR does

<!-- 一个 PR 尽量只做一件事 / Keep each PR focused on a single change -->

## 核心约束核查 / Core Invariants Check

- [ ] 后台无感：未引入任何对后台应用的 `activate`、无 `-g` 的 `open -a` 或非用户主动触发的 `AXRaise` / No background focus stealing or window raising added
- [ ] 写入闸门：所有新增或修改的原生桌面写入在派发前经过 `TakeoverController` 校验 / All native writes pass `TakeoverController` dispatch checks
- [ ] 沙箱与权限：未放宽 `strict.sb` 默认拒绝策略或泄露本地 Token / `AXSecureTextField` 内容 / Sandbox default-deny and secret/secure-field protections intact

## 测试与验证 / Testing & Verification

<!-- 列出运行过的命令及实测结果，如 `npm run build:native && npm test` / List commands run and observed results -->

## 截图 / Screenshots (可选 / Optional)

<!-- 如涉及 Side-Pane 小窗 UI 改动请附上前后截图 / Attach before/after screenshots for UI changes -->
