# 后台持有调试连接租约，状态页持有采集数据

Chromium 的调试连接按扩展持有，关闭记录状态页不会自动释放连接，依据是 [debugger 实现](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/api/debugger/debugger_api.cc)。因此由后台的独立连接队列持有最小租约，使用宿主加载代际和批次标识隔离旧操作，并在旧 attach/detach 收束后才允许交接连接。后台只持久化连接所有权信息，接口正文、截图和未提交快照仍由状态页内存持有，保持本轮不提供跨重启数据恢复的边界。
