const { contextBridge, ipcRenderer } = require("electron");
const allowed = new Set([
  "app.info",
  "network.select",
  "network.save",
  "rpc.test",
  "wallets.import",
  "wallets.remove",
  "wallets.importFile",
  "wallets.export",
  "wallets.template",
  "wallets.lock",
  "vault.save",
  "vault.unlock",
  "vault.backup",
  "batch.preview",
  "batch.start",
  "batch.stop",
  "approval.query",
  "approval.send",
  "journal.query",
  "journal.refresh",
  "journal.diagnose",
  "journal.retry",
  "journal.export",
  "app.openTransaction",
]);
contextBridge.exposeInMainWorld(
  "desktop",
  Object.freeze({
    async invoke(method, args = {}) {
      if (!allowed.has(method)) throw Error("不支持的操作");
      const r = await ipcRenderer.invoke("batch:invoke", method, args);
      if (!r.ok) throw Error(r.error || "操作失败");
      return r.value;
    },
    onEvent(callback) {
      if (typeof callback !== "function") throw Error("需要回调");
      const fn = (_e, value) => callback(value);
      ipcRenderer.on("batch:event", fn);
      return () => ipcRenderer.removeListener("batch:event", fn);
    },
  }),
);
