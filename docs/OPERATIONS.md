# 本地运行与数据维护

## 构建并发

- 同时最多运行两个 Gradle 构建任务。
- 相同 Gradle Wrapper 分发包在同一 Agent 进程内共用一次下载与校验，避免并行构建竞争 `.zip.download` 缓存。
- Android SDK 安装会在并发项目之间重新检查各自所需的 SDK、NDK 与 CMake 包；先完成的安装不会让后续项目误判为已就绪。
- 构建目标优先从项目自身 Gradle Wrapper 的 `tasks --all` 输出中识别 `assemble<Variant>`，无法读取时才回退到静态 Gradle 配置解析。

## 本地受管调试签名

当项目声明的本地 JKS 缺失时，Agent 会在本机受管目录生成稳定的调试签名，并仅在构建期间把副本放入项目所需路径。构建结束后项目副本会删除，受管密钥会保留，以保证下一次构建可以覆盖安装。

受管签名不会自动清理。若主动删除，之后重新构建的 APK 签名会变化，安装到已有同包名应用时可能需要先卸载旧应用。

## 可清理数据

可通过本地 Agent API 查询和清理以下数据：构建日志、测试报告截图、上传产物和下载中转文件。

```text
GET  /api/v1/system/storage
POST /api/v1/system/storage/cleanup
```

清理请求必须显式携带 `approved: true`、要清理的分类和保留天数。Android SDK、Gradle 缓存、Appium、Git 项目检出目录及受管签名始终排除在自动清理之外。
