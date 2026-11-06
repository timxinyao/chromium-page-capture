# 项目规则

- 本项目是本地处理的 Chromium Manifest V3 页面采集扩展，默认用简体中文沟通和维护说明。
- extension/ 是浏览器加载目录；tests/ 保存 Node VM 回归检查；scripts/ 保存开发和打包工具；dist/ 只放忽略的构建产物。
- page.json 顶层是数组，每项只有 request 和 response。采集说明、备注、类别、统计、计时和正文省略原因统一写入 note.txt。
- 网络导出范围为 Fetch/XHR，保留实际 HTTP 方法，并排除可识别的扩展发起请求。当前页面的截图默认整页。
- 用户点击后只采集当前标签页。默认重载原页面以记录加载接口，入口无二次确认框；终态按钮关闭采集页并返回原标签页。
- 新增浏览器权限、外部上传或自动遍历行为属于重要范围变化，实施前向用户说明并取得明确授权。
- 仓库只保存源码和合成测试数据。真实 HAR、采集 JSON、截图、备注、凭据、客户地址和本机认证脚本保留在仓库外。
- 修改导出、过滤、生命周期或标签页行为后，运行 npm test 和 npm run check。VM 检查不等于真实浏览器验证，README 应写清实际覆盖范围。
- 扩展版本保持 extension/manifest.json、extension/capture.js 的 CAPTURE_VERSION 和 package.json 一致，打包从 manifest 读取版本。
- 公开说明以 README.md 为准；新增使用限制和完成状态就地更新，避免平行说明。