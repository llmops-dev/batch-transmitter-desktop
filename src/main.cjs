"use strict";
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  session,
  safeStorage,
  shell,
} = require("electron");
const fs = require("node:fs"),
  path = require("node:path"),
  { pathToFileURL } = require("node:url");
const { Engine } = require("./engine.cjs"),
  { Vault } = require("./vault.cjs"),
  { Journal } = require("./journal.cjs"),
  { cleanError, integer } = require("./runtime.cjs");
const XLSX = require("./xlsx.cjs");
const { isTrustedPage } = require("./page-security.cjs");
const root = path.resolve(__dirname, ".."),
  smoke = process.argv.includes("--verify-startup"),
  smokeDir = smoke
    ? fs.mkdtempSync(
        path.join(app.getPath("temp"), "batch-transmitter-verify-"),
      )
    : null;
if (smoke) app.setPath("userData", path.join(smokeDir, "profile"));
else
  app.setPath(
    "userData",
    path.join(app.getPath("appData"), "Batch-Transmitter-Desktop"),
  );
const page = pathToFileURL(path.join(root, "renderer/index.html")).href;
let window,
  engine,
  vault,
  journal,
  quitting = false;
async function confirm(kind, c, network, n) {
  const text =
    kind === "approval"
      ? `授权 Token：${c.token}\n接收授权地址：${c.to}\n方式：${c.mode === "unlimited" ? "无限授权，结束任务不会自动撤销" : c.mode === "revoke" ? "清零撤销" : c.amount + " 最小单位"}`
      : kind === "retry"
        ? `重发原交易：${c.hash}\n地址：${c.to}\nnonce：${c.nonce}`
        : `接收地址：${c.to}\n每钱包每笔支付：${c.value} ${network.nativeSymbol}\n每钱包次数：${c.count || "不限"}\ncalldata：${c.data.slice(0, 180)}${c.data.length > 180 ? "…" : ""}\n未确认笔数：不限\n钱包、节点及费用配置 SHA-256：${c.snapshotHash}\n具体费用上限见交易预览。停止不能撤回已广播交易`;
  const r = await dialog.showMessageBox(window, {
    type: "question",
    buttons: ["取消", "确认执行"],
    defaultId: 0,
    cancelId: 0,
    title: "本机签名确认",
    message: `${network.name} / Chain ID ${network.chainId} · ${n} 个钱包`,
    detail: text,
  });
  return r.response === 1;
}
async function saveFile(title, defaultPath, data, extensions) {
  const r = await dialog.showSaveDialog(window, {
    title,
    defaultPath,
    filters: [{ name: "文件", extensions }],
  });
  if (r.canceled) return { cancelled: true };
  fs.writeFileSync(r.filePath, data, { mode: 0o600 });
  return { saved: true };
}
async function invoke(method, a) {
  switch (method) {
    case "app.info":
      return engine.info();
    case "network.select":
      return engine.select(a.chainId);
    case "network.save":
      return engine.saveNetwork(a.network);
    case "rpc.test": {
      const generation = engine.generation,
        p = await engine.poolFor({ rpc: a.rpc }),
        [block, fees] = await Promise.all([p.read("getBlockNumber"), p.fees()]);
      if (generation !== engine.generation) throw Error("连接结果已过期");
      return { chainId: engine.network.chainId, block, fees };
    }
    case "wallets.import":
      return engine.importRows(a.rows);
    case "wallets.remove":
      return engine.removeWallet(a.address);
    case "wallets.lock":
      return engine.change(async () => vault.lock());
    case "vault.save":
      return engine.change(async () => vault.save(a.password));
    case "vault.unlock":
      return engine.change(async () => vault.unlock(a.password));
    case "vault.backup": {
      const f = path.join(app.getPath("userData"), "wallet-vault.json");
      if (!fs.existsSync(f)) throw Error("请先保存加密保险库");
      return saveFile(
        "备份已保存的加密保险库",
        "batch-wallet-vault-backup.json",
        fs.readFileSync(f),
        ["json"],
      );
    }
    case "wallets.importFile": {
      const generation = engine.generation;
      const r = await dialog.showOpenDialog(window, {
        title: "导入 accounts 工作表",
        properties: ["openFile"],
        filters: [{ name: "Excel 钱包列表", extensions: ["xlsx"] }],
      });
      if (r.canceled) return { cancelled: true };
      const f = r.filePaths[0];
      if (fs.statSync(f).size > 5 * 1024 * 1024) throw Error("文件超过 5 MiB");
      const rows = await require("./xlsx-worker.cjs").read(fs.readFileSync(f));
      if (generation !== engine.generation)
        throw Error("导入期间设置已改变，请重新导入");
      return engine.importRows(rows);
    }
    case "wallets.template":
      return saveFile(
        "导出原站格式模板",
        "accounts-template.xlsx",
        await XLSX.write(
          Array.from({ length: 3 }, () => ({
            rpc: "",
            privatekey: "",
            gasPrice: "5",
            gasLimit: "2000000",
            eip1559: false,
            maxFee: "5",
            maxPriorityFee: "0.1",
          })),
        ),
        ["xlsx"],
      );
    case "wallets.export":
      return engine.change(async () => {
        const includeKeys = a.includeKeys === true;
        if (includeKeys) {
          const r = await dialog.showMessageBox(window, {
            type: "warning",
            buttons: ["取消", "导出明文私钥"],
            defaultId: 0,
            cancelId: 0,
            message: "这个 XLSX 将包含钱包私钥和 RPC 配置。",
            detail: "只保存到你控制的本机位置，不要上传或转发。",
          });
          if (r.response !== 1) return { cancelled: true };
        }
        const rows = engine.profiles().map((p) => ({
          ...p,
          privatekey: includeKeys ? vault.getSigner(p.address).privateKey : "",
        }));
        return saveFile(
          includeKeys
            ? "导出含私钥钱包列表"
            : "导出不含私钥配置（重新导入需补私钥）",
          "accounts.xlsx",
          await XLSX.write(rows),
          ["xlsx"],
        );
      });
    case "batch.preview":
      return engine.preview(a.config);
    case "batch.start":
      return engine.start(a.previewId);
    case "batch.stop":
      return engine.stop();
    case "approval.query":
      return engine.allowance(a);
    case "approval.send":
      return engine.approve(a);
    case "journal.query":
      return journal.page(
        engine.network.chainId,
        integer(a.limit ?? 100, 1, 200, "分页数量"),
        integer(a.offset ?? 0, 0, 1e9, "分页位置"),
      );
    case "journal.refresh":
      await engine.poll();
      return engine.info();
    case "journal.diagnose":
      return engine.diagnose(a.hash);
    case "journal.retry":
      return engine.retry(a.hash);
    case "journal.export": {
      const chainId = engine.network.chainId;
      const r = await dialog.showSaveDialog(window, {
        title: "导出当前链交易记录，不含签名原文或私钥",
        defaultPath: "transactions.jsonl",
      });
      if (r.canceled) return { cancelled: true };
      const fd = fs.openSync(r.filePath, "w", 0o600);
      try {
        for (let offset = 0; ; offset += 200) {
          const rows = journal.page(chainId, 200, offset);
          if (!rows.length) break;
          for (const row of rows) fs.writeSync(fd, JSON.stringify(row) + "\n");
        }
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return { saved: true };
    }
    case "app.openTransaction":
      if (!/^0x[0-9a-f]{64}$/i.test(a.hash)) throw Error("哈希无效");
      if (!engine.network.explorer) throw Error("当前网络未设置浏览器");
      await shell.openExternal(engine.network.explorer + "/tx/" + a.hash);
      return true;
    default:
      throw Error("不支持的操作");
  }
}
async function start() {
  await app.whenReady();
  if (!safeStorage.isEncryptionAvailable())
    throw Error("Windows 本机加密不可用，拒绝明文保存 RPC 和签名交易");
  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const data = app.getPath("userData");
  vault = new Vault({ file: path.join(data, "wallet-vault.json") });
  journal = new Journal(path.join(data, "transactions.sqlite"), {
    encode: (s) => safeStorage.encryptString(s).toString("base64"),
    decode: (s) => safeStorage.decryptString(Buffer.from(s, "base64")),
  });
  engine = new Engine({
    vault,
    journal,
    confirm,
    onEvent: (event) => {
      if (window && !window.isDestroyed())
        window.webContents.send("batch:event", event);
    },
  });
  ipcMain.handle("batch:invoke", async (event, method, args) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      !isTrustedPage(event.senderFrame.url, page)
    )
      return { ok: false, error: "拒绝未知页面" };
    try {
      if (
        typeof method !== "string" ||
        !args ||
        typeof args !== "object" ||
        Array.isArray(args) ||
        JSON.stringify(args).length > 1100000
      )
        throw Error("请求格式无效");
      return { ok: true, value: await invoke(method, args) };
    } catch (e) {
      return { ok: false, error: cleanError(e) };
    }
  });
  window = new BrowserWindow({
    width: 1460,
    height: 1040,
    minWidth: 1060,
    minHeight: 740,
    show: false,
    autoHideMenuBar: true,
    title: "批量万能上链器",
    backgroundColor: "#f5f8fa",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (e) => e.preventDefault());
  window.webContents.on("will-attach-webview", (e) => e.preventDefault());
  window.once("ready-to-show", () => {
    if (!smoke) window.show();
  });
  await window.loadURL(page);
  if (smoke) {
    const result = await window.webContents.executeJavaScript(
      `(async()=>{for(let i=0;i<100&&!document.querySelector('#network-select option');i++)await new Promise(r=>setTimeout(r,50));let denied=false;try{await window.desktop.invoke('evil');}catch{denied=true;}const info=await window.desktop.invoke('app.info');document.getElementById('wallet-dialog').showModal();await new Promise(r=>requestAnimationFrame(r));const dialogVisible=document.getElementById('wallet-dialog').open;document.getElementById('wallet-dialog').close();for(const mode of ['time','probe','listen','block']){document.querySelector('[data-mode="'+mode+'"]').click();}return{version:info.version,uiVersion:document.querySelector(".version").textContent,footerVersion:document.querySelector("footer").textContent,network:info.network.chainId,wallets:info.wallets.length,nodeHidden:typeof require==='undefined'&&typeof process==='undefined',denied,dialogVisible,modeCount:document.querySelectorAll('[data-mode]').length,overflow:document.documentElement.scrollWidth>innerWidth,bridge:true};})()`,
    );
    result.packaged = app.isPackaged;
    result.security = window.webContents.getLastWebPreferences();
    // Reproduce real sidebar navigation + network selection in the actual EXE,
    // with isolated userData and no imported wallets or broadcast operations.
    let releaseSwitch;
    engine.track(new Promise((resolve) => { releaseSwitch = resolve; }));
    const duringSwitch = await window.webContents.executeJavaScript(`(()=>{
      const selector=document.getElementById('network-select');
      previewId='stale-test-preview';
      selector.value='1';
      globalThis.verifySwitch=selector.onchange();
      return {selection:selector.value,label:document.getElementById('chain-label').textContent,
        controlsDisabled:['network-select','network-manage','start','preview','authorize','wallet-manage'].every(id=>document.getElementById(id).disabled),
        previewInvalidated:previewId===null};
    })()`);
    releaseSwitch();
    await window.webContents.executeJavaScript(`globalThis.verifySwitch`);
    const switchChecks = await window.webContents.executeJavaScript(`(async()=>{
      const samples=[], selector=document.getElementById('network-select');
      for(const anchor of document.querySelectorAll('.nav-link')) {
        anchor.click(); await new Promise(r=>requestAnimationFrame(r));
        for(const id of ['8453','1','56','4663','137','43114']) {
          selector.value=id; await selector.onchange();
          const info=await window.desktop.invoke('app.info');
          samples.push({anchor:location.hash,chainId:info.network.chainId,
            consistent:info.network.chainId===id && selector.value===id &&
              document.getElementById('chain-label').textContent===info.network.name+' / Chain ID '+id &&
              [...document.querySelectorAll('.native-symbol')].every(el=>el.textContent===info.network.nativeSymbol)});
        }
      }
      const before=await window.desktop.invoke('app.info'), stale=structuredClone(before);
      const invalid=document.createElement('option');invalid.value='999999999';selector.append(invalid);
      selector.value=invalid.value;await selector.onchange();
      const failureRestored=selector.value===before.network.chainId &&
        document.getElementById('chain-label').textContent===before.network.name+' / Chain ID '+before.network.chainId &&
        document.getElementById('toast').textContent.includes('网络不存在') && !selector.disabled;
      selector.value='8453';await selector.onchange();
      render(stale);
      const staleIgnored=selector.value==='8453' && document.getElementById('chain-label').textContent==='Base / Chain ID 8453';
      document.querySelector('.nav-link[href="#top"]').click();window.scrollTo(0,0);
      document.getElementById('toast').hidden=true;
      return {samples,failureRestored,staleIgnored,options:[...selector.options].map(o=>o.value),
        controlsReleased:['network-select','network-manage','start','preview','authorize','wallet-manage'].every(id=>!document.getElementById(id).disabled)};
    })()`);
    result.networkSwitch = { duringSwitch, ...switchChecks };
    result.networkSwitch.passed = duringSwitch.selection === "8453" &&
      duringSwitch.label === "Base / Chain ID 8453" && duringSwitch.controlsDisabled &&
      duringSwitch.previewInvalidated && switchChecks.samples.length === 30 &&
      switchChecks.samples.every((s) => s.consistent) && switchChecks.failureRestored &&
      switchChecks.staleIgnored && switchChecks.controlsReleased && switchChecks.options.length === 6;
    // Exercise actual renderer/IPC responses with delayed read-only fixture
    // results. This branch always uses isolated verification userData.
    const savedAllowance = engine.allowance;
    const pendingAllowances = [];
    engine.allowance = () => new Promise(resolve => pendingAllowances.push(resolve));
    const startQuery = () => window.webContents.executeJavaScript(`(()=>{
      globalThis.auditAllowanceQuery=document.getElementById('allowance-query').onclick();
    })()`);
    const queryResult = symbol => ({ symbol, decimals: null,
      wallets: [{ address: "0x1111111111111111111111111111111111111111", allowance: "123" }] });
    const queryStarted = async count => {
      for (let i=0;i<100 && pendingAllowances.length<count;i++)
        await new Promise(resolve=>setTimeout(resolve,10));
      if (pendingAllowances.length!==count) throw Error("额度界面验收请求未开始");
    };
    try {
      await startQuery(); await queryStarted(1);
      await window.webContents.executeJavaScript(`(()=>{
        const target=document.getElementById('target');target.value='0x2222222222222222222222222222222222222222';
        target.dispatchEvent(new Event('input',{bubbles:true}));
      })()`);
      pendingAllowances[0](queryResult("OLD-TARGET"));
      await window.webContents.executeJavaScript(`globalThis.auditAllowanceQuery`);
      const targetSafe = await window.webContents.executeJavaScript(`!document.getElementById('allowance-result').textContent.includes('OLD-TARGET')`);
      await startQuery(); await queryStarted(2);
      await window.webContents.executeJavaScript(`(()=>{const s=document.getElementById('network-select');s.value='137';globalThis.auditSwitch=s.onchange();})()`);
      await window.webContents.executeJavaScript(`globalThis.auditSwitch`);
      pendingAllowances[1](queryResult("OLD-NETWORK"));
      await window.webContents.executeJavaScript(`globalThis.auditAllowanceQuery`);
      const networkSafe = await window.webContents.executeJavaScript(`!document.getElementById('allowance-result').textContent.includes('OLD-NETWORK')`);
      await startQuery(); await queryStarted(3);
      await window.webContents.executeJavaScript(`(()=>{globalThis.auditOldQuery=globalThis.auditAllowanceQuery;})()`);
      await startQuery(); await queryStarted(4);
      pendingAllowances[3](queryResult("NEW-QUERY"));
      await window.webContents.executeJavaScript(`globalThis.auditAllowanceQuery`);
      pendingAllowances[2](queryResult("OLD-QUERY"));
      await window.webContents.executeJavaScript(`globalThis.auditOldQuery`);
      const orderSafe = await window.webContents.executeJavaScript(`document.getElementById('allowance-result').textContent.includes('NEW-QUERY')&&!document.getElementById('allowance-result').textContent.includes('OLD-QUERY')`);
      result.allowanceContext = { targetSafe, networkSafe, orderSafe, fixtureOnly: true,
        passed: targetSafe && networkSafe && orderSafe };
      await window.webContents.executeJavaScript(`(()=>{const s=document.getElementById('network-select');s.value='8453';globalThis.auditSwitch=s.onchange();})()`);
      await window.webContents.executeJavaScript(`globalThis.auditSwitch`);
    } finally { engine.allowance = savedAllowance; }
    // All verification uses a fresh temporary userData directory. No real vault
    // or previously imported wallet can be accessed through this path.
    const {
      Wallet,
      keccak256,
      JsonRpcProvider,
      parseEther,
    } = require("ethers");
    const testKey = keccak256(Buffer.from("batch-packaged-local-only"));
    const testRow = {
      privatekey: testKey,
      rpc: "http://127.0.0.1:1",
      gasPrice: "2",
      gasLimit: "21000",
      eip1559: true,
      maxFee: "3",
      maxPriorityFee: "0.1",
    };
    await engine.importRows([testRow]);
    const bytes = await XLSX.write([testRow]);
    fs.writeFileSync(path.join(smokeDir, "accounts-test.xlsx"), bytes);
    const imported = await require("./xlsx-worker.cjs").read(bytes);
    result.xlsxRoundtrip =
      imported.length === 1 && imported[0].privatekey === testKey;
    await vault.save("packaged-test-password-only");
    result.encryptedVault = !fs
      .readFileSync(path.join(smokeDir, "profile/wallet-vault.json"), "utf8")
      .includes(testKey.slice(2));
    vault.lock();
    await vault.unlock("packaged-test-password-only");
    result.walletImport =
      vault.count === 1 &&
      !JSON.stringify(engine.info()).includes(testKey.slice(2));
    await engine.saveNetwork({
      chainId: "31337",
      name: "Local verify",
      nativeSymbol: "ETH",
      decimals: 18,
      gasMode: "eip1559",
    });
    await engine.select("31337");
    result.customNetwork =
      (await invoke("app.info", {})).network.chainId === "31337";
    await engine.select("8453");
    result.stopTask = (await invoke("batch.stop", {})).status === "stopped";
    if (process.env.BATCH_VERIFY_RPC) {
      const endpoint = new URL(process.env.BATCH_VERIFY_RPC);
      if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1")
        throw Error("验收节点仅允许本机回环地址");
      const rpc = new JsonRpcProvider(endpoint.toString(), undefined, {
        batchMaxCount: 1,
        cacheTimeout: -1,
      });
      try {
        if ((await rpc.getNetwork()).chainId !== 31337n)
          throw Error("验收节点必须使用本地 31337 测试链");
        await engine.select("31337");
        const rows = Array.from({ length: 100 }, (_, i) => ({
          ...testRow,
          rpc: endpoint.toString(),
          privatekey: keccak256(Buffer.from("batch-packaged-local-only-" + i)),
        }));
        await Promise.all(
          rows.map((r) =>
            rpc.send("anvil_setBalance", [
              new Wallet(r.privatekey).address,
              "0x" + parseEther("100").toString(16),
            ]),
          ),
        );
        await engine.importRows(rows);
        // This confirmation override exists only for isolated synthetic tests.
        engine.confirm = async () => true;
        const wait = async (fn) => {
          const end = Date.now() + 60000;
          while (Date.now() < end) {
            if (fn()) return;
            await new Promise((r) => setTimeout(r, 20));
          }
          throw Error("EXE 本地交易验收超时");
        };
        const target = "0x1111111111111111111111111111111111111111";
        await rpc.send("evm_setAutomine", [false]);
        let p = await engine.preview({
          to: target,
          count: 125,
          intervalMs: 1,
          rps: 1000,
          walletAddresses: [new Wallet(rows[0].privatekey).address],
        });
        const first = performance.now();
        await engine.start(p.previewId);
        let run = engine.run;
        await wait(
          () =>
            journal.totals(run.id).accepted === 125 &&
            run.operations.size === 0,
        );
        await engine.stop();
        result.nativePending = {
          accepted: 125,
          ms: Math.round(performance.now() - first),
          rpcAcceptedOnly: journal.totals(run.id).success === 0,
        };
        await rpc.send("evm_mine", []);
        await rpc.send("evm_setAutomine", [true]);
        p = await engine.preview({
          to: target,
          count: 2,
          intervalMs: 1,
          concurrency: 4,
          rps: 1000,
        });
        const second = performance.now();
        await engine.start(p.previewId);
        run = engine.run;
        await wait(
          () =>
            journal.totals(run.id).accepted === 200 &&
            run.operations.size === 0,
        );
        await engine.stop();
        await rpc.send("evm_mine", []);
        result.nativeWalletBatch = {
          wallets: 100,
          accepted: 200,
          ms: Math.round(performance.now() - second),
          memoryRssMiB: Math.round(process.memoryUsage().rss / 1048576),
        };
        const receiptDeadline = Date.now() + 60000;
        while (Date.now() < receiptDeadline) {
          await engine.poll();
          if (journal.totals(run.id).success === 200) break;
          await new Promise((r) => setTimeout(r, 30));
        }
        result.nativeConfirmed = journal.totals(run.id).success === 200;
        // Real EVM code needs gas beyond the intrinsic transaction charge.
        // A 21k probe must remain closed; increasing its configured limit must
        // allow the same synthetic wallet to execute the storage write.
        const probeTarget = "0x3333333333333333333333333333333333333333";
        await rpc.send("anvil_setCode", [probeTarget, "0x600160005500"]);
        const probeWallet = new Wallet(rows[0].privatekey).address;
        p = await engine.preview({ to: probeTarget, mode: "probe", count: 1,
          walletAddresses: [probeWallet] });
        await engine.start(p.previewId);
        await Promise.allSettled([...engine.ops]);
        const lowGasBlocked = journal.totals(engine.run.id).signed === 0 && !engine.run.wallets[0].probed;
        await engine.stop();
        await engine.importRows([{ ...rows[0], gasLimit: "100000" }]);
        p = await engine.preview({ to: probeTarget, mode: "probe", count: 1,
          walletAddresses: [probeWallet] });
        await engine.start(p.previewId); run = engine.run;
        await wait(() => journal.totals(run.id).accepted === 1 && run.operations.size === 0);
        await engine.stop(); await rpc.send("evm_mine", []); await engine.poll();
        const probeDeadline = Date.now() + 20000;
        while (journal.totals(run.id).success !== 1 && Date.now() < probeDeadline) {
          await new Promise(resolve => setTimeout(resolve, 30));
          await engine.poll();
        }
        const highGasSucceeded = journal.totals(run.id).success === 1;
        const stored = await rpc.getStorage(probeTarget, 0);
        result.nativeProbeGas = { lowGasBlocked, highGasSucceeded, storageWritten: BigInt(stored) === 1n,
          passed: lowGasBlocked && highGasSucceeded && BigInt(stored) === 1n };
        const probeRecord = journal.page("31337").find(r => r.taskId === run.id);
        const diagnosed = await engine.diagnose(probeRecord.hash);
        result.nativeDiagnostic = { passed: diagnosed.length === 1 && diagnosed[0].transactionSeen === true &&
          diagnosed[0].receiptSeen === true && diagnosed[0].receiptStatus === 1 && diagnosed[0].errors.length === 0 };
      } finally {
        rpc.destroy();
      }
      await engine.select("8453");
    }
    await window.webContents.executeJavaScript(
      `(async()=>{await window.desktop.invoke('batch.stop');render(await window.desktop.invoke('app.info'));document.getElementById('wallet-manage').click();await new Promise(r=>setTimeout(r,200));})()`,
    );
    fs.writeFileSync(
      path.join(smokeDir, "wallet-modal.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    await window.webContents.executeJavaScript(
      `document.getElementById('wallet-dialog').close()`,
    );
    result.secretFieldCheck = await window.webContents.executeJavaScript(
      `(async()=>{document.getElementById('wallet-manage').click();const secret=document.querySelector('#wallet-rows input[type="password"]');secret.value=${JSON.stringify(testKey)};secret.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('save-wallets').click();for(let i=0;i<100&&document.getElementById('wallet-dialog').open;i++)await new Promise(r=>setTimeout(r,50));await new Promise(r=>setTimeout(r,50));return {closed:!document.getElementById('wallet-dialog').open,cleared:[...document.querySelectorAll('#wallet-dialog input[type="password"]')].every(el=>el.value===''),message:document.getElementById('toast').textContent};})()`,
    );
    result.secretFieldsCleared = result.secretFieldCheck.closed && result.secretFieldCheck.cleared;
    let releaseLockDrain;
    engine.track(new Promise(resolve => { releaseLockDrain = resolve; }));
    try {
      result.walletLockBeforeDrain = await window.webContents.executeJavaScript(`(()=>{
        document.getElementById('wallet-manage').click();
        document.getElementById('paste-keys').value='synthetic-audit-only';
        document.getElementById('vault-password').value='synthetic-audit-only';
        document.getElementById('export-private').checked=true;
        const key=document.querySelector('#wallet-rows input[type="password"]');
        if(key)key.value='synthetic-audit-only';
        globalThis.auditLockOperation=document.getElementById('vault-lock').onclick();
        const cleared=document.getElementById('paste-keys').value==='' &&
          !document.getElementById('export-private').checked &&
          [...document.querySelectorAll('#wallet-dialog input[type="password"]')].every(el=>el.value==='');
        document.getElementById('paste-keys').value='synthetic-late-draft';
        document.getElementById('vault-password').value='synthetic-late-draft';
        document.getElementById('export-private').checked=true;
        return {cleared};
      })()`);
    } finally {
      releaseLockDrain();
    }
    await window.webContents.executeJavaScript(`globalThis.auditLockOperation`);
    result.walletLockAfterDrain = await window.webContents.executeJavaScript(`(async()=>{
      const info=await window.desktop.invoke('app.info');
      const cleared=document.getElementById('paste-keys').value==='' &&
        !document.getElementById('export-private').checked &&
        [...document.querySelectorAll('#wallet-dialog input[type="password"]')].every(el=>el.value==='') &&
        walletDraft.every(w=>!w.privatekey) && !draftDirty;
      document.getElementById('wallet-dialog').close();
      return {cleared,locked:info.vault.locked,signersUnavailable:info.wallets.every(w=>!w.loaded)};
    })()`);
    result.walletLockCleared = result.walletLockBeforeDrain.cleared &&
      result.walletLockAfterDrain.cleared && result.walletLockAfterDrain.locked &&
      result.walletLockAfterDrain.signersUnavailable;
    result.passed =
      result.version === require("../package.json").version &&
      result.uiVersion.includes(result.version) && result.footerVersion.includes(result.version) &&
      result.network === "8453" &&
      result.wallets === 0 &&
      result.nodeHidden &&
      result.denied &&
      result.dialogVisible &&
      result.modeCount === 4 &&
      result.xlsxRoundtrip &&
      result.encryptedVault &&
      result.walletImport &&
      result.customNetwork &&
      result.stopTask &&
      result.networkSwitch.passed &&
      result.allowanceContext.passed &&
      result.secretFieldsCleared &&
      result.walletLockCleared &&
      (!process.env.BATCH_VERIFY_RPC || (result.nativeConfirmed && result.nativeProbeGas.passed && result.nativeDiagnostic.passed)) &&
      !result.overflow;
    fs.writeFileSync(
      path.join(smokeDir, "electron-smoke.json"),
      JSON.stringify(result, null, 2),
    );
    fs.writeFileSync(
      path.join(smokeDir, "desktop-preview.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    console.log(JSON.stringify({ passed: result.passed, directory: smokeDir }));
    await engine.close();
    engine = null;
    app.exit(result.passed ? 0 : 1);
  }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (e) => {
    if (quitting || !engine) return;
    e.preventDefault();
    quitting = true;
    engine
      .close()
      .catch(() => {})
      .finally(() => {
        engine = null;
        app.quit();
      });
  });
  start().catch((e) => {
    if (!smoke) dialog.showErrorBox("启动失败", cleanError(e));
    else console.error(cleanError(e));
    app.exit(1);
  });
}
