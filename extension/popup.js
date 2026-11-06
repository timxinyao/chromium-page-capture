const node = (id) => document.getElementById(id);
let currentView = null;
let busy = false;
let commandSequence = 0;
const panelId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
const PHASE_NAMES = {
  idle: "未开始", initial: "首次准备", recording: "记录中", saving: "保存中",
  retry: "等待重试", ending: "结束中", interrupted: "已中断", ended: "已结束"
};

function render(view) {
  currentView = view;
  const phase = view.phase;
  node("phase").textContent = PHASE_NAMES[phase] || phase;
  node("status").textContent = view.message;
  node("details").textContent = view.folder
    ? "已保存 " + view.savedCount + " 份 · 未留档 " + view.unsavedCount + " 条 · 未完成 " + view.pendingCount + " 条"
    : "";
  node("warning").textContent = [view.warning, view.frameCoverage].filter(Boolean).join("\n");
  node("start").hidden = phase !== "idle" && phase !== "ended";
  node("start").textContent = phase === "ended" ? "开始下一批" : "开始本批";
  node("save").hidden = phase !== "recording";
  node("end").hidden = phase !== "recording";
  node("retry").hidden = phase !== "retry";
  node("recover").hidden = phase !== "interrupted";
  node("abandon").hidden = !["retry", "interrupted"].includes(phase);
  node("openHost").hidden = !view.hostId;
  node("note").disabled = busy || !["idle", "ended", "recording", "interrupted"].includes(phase);
  for (const id of ["start", "save", "end", "retry", "recover", "abandon", "openHost"]) node(id).disabled = busy;
}

async function send(command, extra = {}) {
  return chrome.runtime.sendMessage({
    channel: "page-capture-router", command,
    commandId: panelId + "-" + ++commandSequence,
    batchId: currentView && currentView.batchId,
    ownerId: currentView && currentView.hostId,
    ...extra
  });
}

async function refresh() {
  if (busy) return;
  try {
    const result = await send("status");
    if (result?.view) render(result.view);
    if (result && !result.ok) node("status").textContent = result.error;
  } catch (error) { node("status").textContent = error.message || String(error); }
}

async function act(command, extra = {}) {
  if (busy) return;
  busy = true;
  if (currentView) render(currentView);
  try {
    const result = await send(command, { note: node("note").value.trim(), ...extra });
    busy = false;
    if (result?.view) render(result.view);
    if (!result?.ok) node("status").textContent = result?.error || "操作没有得到确认，请查看记录状态页。";
    else if (["start", "save", "end", "recover"].includes(command)) node("note").value = "";
    if (result?.ok && command === "openHost") window.close();
  } catch (error) {
    busy = false;
    if (currentView) render(currentView);
    node("status").textContent = (error.message || String(error)) + "。请重新打开面板查看批次状态。";
  }
}

for (const id of ["start", "save", "end", "retry", "recover", "openHost"]) node(id).addEventListener("click", () => act(id));
node("abandon").addEventListener("click", () => { node("abandonConfirmation").hidden = false; });
node("cancelAbandon").addEventListener("click", () => { node("abandonConfirmation").hidden = true; });
node("confirmAbandon").addEventListener("click", () => {
  node("abandonConfirmation").hidden = true;
  void act("abandon", { confirmed: true });
});
void refresh();
const polling = setInterval(() => { void refresh(); }, 800);
window.addEventListener("unload", () => clearInterval(polling));
