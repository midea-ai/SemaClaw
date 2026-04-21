# vendor

本地固化的依赖 tarball，用于在 sema-core 仓库暂时不可访问期间保证 `npm install` 可重现。

当前固化：

- `sema-core-1.0.0.tgz` — 对应 `package.json` 中的 `"sema-core": "file:./vendor/sema-core-1.0.0.tgz"`

## 重新生成

在 semaclaw 仓库根目录执行：

```bash
npm pack /path/to/sema-code-core --pack-destination ./vendor
```

注意：
- 使用 `--pack-destination` 显式指定输出目录，避免 tarball 被下一次 `npm pack` 递归包进新包里。
- 更新 tarball 后，同步修改 `package.json` 中 `sema-core` 的文件名，并重新执行 `npm install`。
- tgz 文件在 `.gitattributes` 中标记为 binary，避免 diff 噪音。
