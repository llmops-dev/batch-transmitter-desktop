"use strict";
const $ = (id) => document.getElementById(id),
  api = (m, a = {}) => window.desktop.invoke(m, a);
let state,
  mode = "block",
  previewId = null,
  page = 0,
  walletDraft = [],
  draftDirty = false,
  configLoadedChain = null,
  lastStateAt = 0,
  revision = 0,
  networkRevision = 0,
  allowanceRevision = 0,
  switchingNetwork = false;
function toast(value) {
  $("toast").textContent = String(value);
  $("toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("toast").hidden = true), 7000);
}
async function action(fn) {
  try {
    return await fn();
  } catch (e) {
    toast(e.message);
    return null;
  }
}
function button(text, fn, cls = "plain") {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.className = cls;
  b.onclick = () => action(fn);
  return b;
}
function field(value, fn, type = "text") {
  const input = document.createElement("input");
  input.type = type;
  type === "checkbox" ? (input.checked = !!value) : (input.value = value ?? "");
  input.oninput = () => fn(type === "checkbox" ? input.checked : input.value);
  return input;
}
function selectMode(next) {
  mode = next;
  for (const tab of document.querySelectorAll("[data-mode]"))
    tab.classList.toggle("active", tab.dataset.mode === next);
  for (const n of ["block", "time", "probe", "listen"])
    $("mode-" + n).hidden = n !== next;
  invalidate();
}
function invalidate() {
  previewId = null;
  revision++;
  if (
    !invalidate.loading &&
    (invalidate.starting ||
      ["running", "waiting"].includes(state?.task?.status)) &&
    !invalidate.stopping
  ) {
    invalidate.stopping = true;
    api("batch.stop")
      .catch((e) => toast(e.message))
      .finally(() => {
        invalidate.stopping = false;
      });
  }
}
function rules() {
  return [...$("rules").children].map((row) => row.rule);
}
function addRule(
  rule = {
    from: "",
    to: "",
    match: "selector",
    selector: "",
    gasPriceGwei: "0",
  },
) {
  const row = document.createElement("tr");
  row.rule = { ...rule };
  for (const key of ["from", "to", "match", "selector", "gasPriceGwei"]) {
    const cell = document.createElement("td");
    let input;
    if (key === "match") {
      input = document.createElement("select");
      for (const [v, t] of [
        ["selector", "函数选择器"],
        ["contains", "包含数据"],
      ]) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = t;
        input.append(o);
      }
      input.value = rule.match;
      input.onchange = () => {
        row.rule.match = input.value;
        invalidate();
      };
    } else
      input = field(rule[key], (v) => {
        row.rule[key] = v;
        invalidate();
      });
    cell.append(input);
    row.append(cell);
  }
  const td = document.createElement("td");
  td.append(
    button("删除", () => {
      row.remove();
      invalidate();
    }),
  );
  row.append(td);
  $("rules").append(row);
  invalidate();
}
const configFields = {
  to: "target",
  value: "value",
  data: "calldata",
  startBlock: "start-block",
  startTime: "start-time",
  probeIntervalMs: "probe-interval",
  subscribeRpc: "listen-rpc",
  addlper: "lp-from",
  routerAddress: "lp-router",
  tokenAddress: "lp-token",
  delaySeconds: "delay",
  count: "count",
  intervalMs: "interval",
  concurrency: "concurrency",
  rps: "rps",
  valueBudget: "value-budget",
  feeBudget: "fee-budget",
  durationMinutes: "duration",
};
function config() {
  const c = { mode };
  for (const [k, id] of Object.entries(configFields)) c[k] = $(id).value;
  for (const [k, id] of Object.entries({
    sniffAddLiquidity: "liquidity-enabled",
    followLiquidityGas: "follow-gas",
  }))
    c[k] = $(id).checked;
  c.customActions = rules();
  return c;
}
function loadConfig(c) {
  for (const [k, id] of Object.entries(configFields))
    if (c[k] != null) $(id).value = c[k];
  $("liquidity-enabled").checked = !!c.sniffAddLiquidity;
  $("follow-gas").checked = !!c.followLiquidityGas;
  $("rules").replaceChildren();
  for (const rule of c.customActions || []) addRule(rule);
  selectMode(c.mode || "block");
}
function render(s) {
  document.querySelector(".version").textContent = `版本 ${s.version} · Windows x64`;
  document.querySelector("footer").textContent = `批量万能上链器 · 独立本机程序 · ${s.version}`;
  if (state && s.stateRevision < state.stateRevision) return;
  state = s;
  $("network-select").replaceChildren(
    ...s.networks.map((n) => {
      const o = document.createElement("option");
      o.value = n.chainId;
      o.textContent = n.name + " · " + n.chainId;
      return o;
    }),
  );
  $("network-select").value = s.network.chainId;
  $("chain-label").textContent =
    s.network.name + " / Chain ID " + s.network.chainId;
  for (const el of document.querySelectorAll(".native-symbol"))
    el.textContent = s.network.nativeSymbol;
  $("vault-badge").textContent = s.vault.locked
    ? "保险库已锁定"
    : "本机钱包 · " + s.vault.count;
  $("wallet-count").textContent =
    "当前配置钱包数量：" + s.wallets.length + " · 已加载 " + s.vault.count;
  if (configLoadedChain !== s.network.chainId) {
    for (const [k, id] of Object.entries(configFields))
      $(id).value =
        {
          value: "0",
          data: "",
          to: "",
          startBlock: "0",
          count: "0",
          intervalMs: "1000",
          probeIntervalMs: "500",
          delaySeconds: "0",
          concurrency: "4",
          rps: "20",
          valueBudget: "0",
          feeBudget: "0",
          durationMinutes: "0",
        }[k] ?? "";
    invalidate.loading = true;
    try {
      loadConfig(s.config);
    } finally {
      invalidate.loading = false;
    }
    configLoadedChain = s.network.chainId;
    page = 0;
    loadRecords.lastPage = 0;
    networkRevision++;
    $("preview-result").hidden = true;
    $("preview-result").textContent = "";
    $("allowance-result").textContent = "";
  }
  $("task-status").textContent =
    {
      idle: "待机",
      waiting: "等待条件",
      running: "运行中",
      stopped: "已停止新增发送",
      submitted: "发送次数已达上限",
      budget: "预算上限",
      error: "错误",
    }[s.task.status] +
    " · " +
    s.task.reason +
    (s.task.chainId && s.task.chainId !== s.network.chainId
      ? `（上次任务：${s.task.networkName} / Chain ID ${s.task.chainId}）` : "");
  const c = s.task.counters || {};
  $("counters").replaceChildren(
    ...[
      ["signed", "已签名"],
      ["accepted", "RPC 接受"],
      ["pending", "待确认"],
      ["unknown", "结果未知"],
      ["success", "打包成功"],
      ["reverted", "打包回滚"],
    ].map(([k, name]) => {
      const el = document.createElement("div");
      el.className = "stat";
      const b = document.createElement("b");
      b.textContent = c[k] || 0;
      el.append(b, document.createTextNode(name));
      return el;
    }),
  );
  $("wallet-results").replaceChildren(
    ...s.wallets.map((w) => {
      const tr = document.createElement("tr"),
        c = w.counters || {};
      for (const text of [
        w.address,
        ...[
          "signed",
          "accepted",
          "unknown",
          "pending",
          "success",
          "reverted",
          "executionFee",
        ].map((k) => c[k] || 0),
      ]) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.append(td);
      }
      return tr;
    }),
  );
  if (page === 0) renderRecords(s.journal);
  $("logs").textContent = s.logs
    .map((l) => `${l.time.slice(11, 19)} [${l.level}] ${l.message}`)
    .join("\n");
  if ($("wallet-dialog").open && !draftDirty) {
    walletDraft = s.wallets.map((w) => ({ ...w, privatekey: "" }));
    renderWallets();
  }
}
function renderRecords(rows) {
  $("page-number").textContent = page + 1;
  $("transactions").replaceChildren(
    ...rows.map((r) => {
      const tr = document.createElement("tr");
      for (const text of [
        new Date(r.createdAt).toLocaleTimeString() +
          " / " +
          r.from.slice(0, 8) +
          "…" +
          r.from.slice(-4),
        r.nonce,
        r.hash.slice(0, 14) + "…",
        {
          prepared: "签名待提交",
          pending: "RPC 接受 / 待确认",
          unknown: "发送结果未知",
          confirmed: "打包成功",
          reverted: "打包回滚",
          cancelled: "未进入网络",
          "mined-success": "已打包成功 / 确认中",
          "mined-revert": "已打包回滚 / 确认中",
          "fee-unknown": "已打包 / 费用未知",
        }[r.status] || r.status,
        r.executionFee ? `${r.executionFee} wei` : "—",
      ]) {
        const td = document.createElement("td");
        td.textContent = text;
        td.title = r.hash;
        tr.append(td);
      }
      const td = document.createElement("td");
      td.append(
        button("查看", () => api("app.openTransaction", { hash: r.hash })),
        button("查询", async () => {
          const result = await api("journal.diagnose", { hash: r.hash });
          toast(
            result
              .map(
                (n) =>
                  `节点 ${n.endpoint}：${n.seen === true ? "找到交易" : n.seen === false ? "暂未找到" : "查询失败"}`,
              )
              .join("\n"),
          );
        }),
      );
      if (["unknown", "pending", "prepared"].includes(r.status))
        td.append(
          button("重发原交易", () => api("journal.retry", { hash: r.hash })),
        );
      tr.append(td);
      return tr;
    }),
  );
}
function blankWallet() {
  return {
    rpc: "",
    privatekey: "",
    gasPrice: "5",
    gasLimit: "2000000",
    eip1559: state?.network.gasMode === "eip1559",
    maxFee: "5",
    maxPriorityFee: "0.1",
  };
}
function renderWallets() {
  $("wallet-rows").replaceChildren(
    ...walletDraft.map((w, index) => {
      const tr = document.createElement("tr"),
        first = document.createElement("td"),
        address = document.createElement("div");
      address.className = "wallet-address";
      address.textContent = w.address || "新钱包";
      first.append(
        address,
        field(w.rpc, (v) => {
          w.rpc = v;
          draftDirty = true;
        }),
        button("测试", async () => {
          const r = await api("rpc.test", { rpc: w.rpc });
          toast(
            `Chain ID ${r.chainId} / 区块 ${r.block}\n建议 GasPrice ${r.fees.gasPriceGwei} gwei`,
          );
        }),
      );
      tr.append(first);
      for (const key of [
        "privatekey",
        "gasPrice",
        "gasLimit",
        "eip1559",
        "maxFee",
        "maxPriorityFee",
      ]) {
        const td = document.createElement("td");
        td.append(
          field(
            w[key],
            (v) => {
              w[key] = v;
              draftDirty = true;
            },
            key === "privatekey"
              ? "password"
              : key === "eip1559"
                ? "checkbox"
                : "text",
          ),
        );
        tr.append(td);
      }
      const td = document.createElement("td");
      td.append(
        button("删除", async () => {
          draftDirty = true;
          if (w.address) await api("wallets.remove", { address: w.address });
          walletDraft.splice(index, 1);
          draftDirty = true;
          renderWallets();
        }),
      );
      tr.append(td);
      return tr;
    }),
  );
}
$("network-select").onchange = async () => {
  if (switchingNetwork) return;
  const selector = $("network-select"), requested = selector.value;
  switchingNetwork = true;
  selector.disabled = true;
  $("network-manage").disabled = true;
  // Until the main process confirms, show the actual active chain, not an
  // uncommitted selection. Disable signed operations while stopping/draining.
  if (state) selector.value = state.network.chainId;
  for (const id of ["start", "preview", "authorize", "wallet-manage", "records-next", "records-prev"]) $(id).disabled = true;
  // network.select owns stop/drain. A separate batch.stop here could race
  // with its generation change and invalidate the newly selected context.
  previewId = null;
  revision++;
  networkRevision++;
  page = 0;
  loadRecords.lastPage = 0;
  renderRecords(state?.journal || []);
  $("preview-result").hidden = true;
  try {
    await action(async () => {
      try {
        render(await api("network.select", { chainId: requested }));
      } finally {
        render(await api("app.info"));
      }
    });
  } finally {
    switchingNetwork = false;
    selector.disabled = false;
    $("network-manage").disabled = false;
    for (const id of ["start", "preview", "authorize", "wallet-manage", "records-next", "records-prev"]) $(id).disabled = false;
    if (state) selector.value = state.network.chainId;
  }
};
$("network-manage").onclick = () => {
  $("network-dialog").showModal();
};
$("save-network").onclick = () =>
  action(async () => {
    const n = await api("network.save", {
      network: {
        chainId: $("custom-chain").value,
        name: $("custom-name").value,
        nativeSymbol: $("custom-symbol").value,
        decimals: $("custom-decimals").value,
        explorer: $("custom-explorer").value,
        gasMode: $("custom-fee-mode").value,
      },
    });
    render(await api("network.select", { chainId: n.chainId }));
    $("network-dialog").close();
  });
for (const b of document.querySelectorAll("[data-close]"))
  b.onclick = () => {
    if (b.dataset.close === "wallet-dialog") {
      clearWalletSecrets();
    }
    $(b.dataset.close).close();
  };
for (const b of document.querySelectorAll("[data-mode]"))
  b.onclick = () => selectMode(b.dataset.mode);
for (const id of [
  ...Object.values(configFields),
  "liquidity-enabled",
  "follow-gas",
])
  $(id).addEventListener("input", invalidate);
$("frequency-slider").oninput = () => {
  $("interval").value = $("frequency-slider").value;
  invalidate();
};
$("add-rule").onclick = () => addRule();
$("wallet-manage").onclick = () => {
  walletDraft = state.wallets.length
    ? state.wallets.map((w) => ({ ...w, privatekey: "" }))
    : Array.from({ length: 3 }, blankWallet);
  draftDirty = false;
  renderWallets();
  $("wallet-dialog").showModal();
};
$("add-wallet").onclick = () => {
  walletDraft.push(blankWallet());
  draftDirty = true;
  renderWallets();
};
$("apply-paste").onclick = () => {
  for (const key of $("paste-keys")
    .value.split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean))
    walletDraft.push({
      ...blankWallet(),
      rpc: $("paste-rpc").value,
      privatekey: key,
    });
  $("paste-keys").value = "";
  draftDirty = true;
  renderWallets();
};
$("save-wallets").onclick = () =>
  action(async () => {
    const rows = walletDraft.filter((w) => w.address || w.privatekey.trim());
    await api("wallets.import", { rows });
    clearWalletSecrets();
    $("wallet-dialog").close();
    render(await api("app.info"));
    toast("钱包已导入本机内存；需要下次解锁时，请加密保存保险库。");
  });
$("import-xlsx").onclick = () =>
  action(async () => {
    const r = await api("wallets.importFile");
    if (!r.cancelled) {
      draftDirty = false;
      render(await api("app.info"));
      toast("XLSX 导入完成");
    }
  });
$("template-xlsx").onclick = () => action(() => api("wallets.template"));
$("export-xlsx").onclick = () =>
  action(() =>
    api("wallets.export", { includeKeys: $("export-private").checked }),
  );
for (const [id, method] of [
  ["vault-save", "vault.save"],
  ["vault-unlock", "vault.unlock"],
])
  $(id).onclick = () =>
    action(async () => {
      const password = $("vault-password").value;
      $("vault-password").value = "";
      await api(method, { password });
      draftDirty = false;
      render(await api("app.info"));
      toast(method === "vault.save" ? "已加密保存" : "保险库已解锁");
    });
$("vault-lock").onclick = () =>
  action(async () => {
    clearWalletSecrets();
    try {
      await api("wallets.lock");
      render(await api("app.info"));
    } finally {
      // Stop/drain can wait on an in-flight request. Clear anything entered
      // during that wait too, including a failed lock request's UI drafts.
      clearWalletSecrets();
    }
  });
$("vault-backup").onclick = () => action(() => api("vault.backup"));
async function doPreview() {
  const rev = revision;
  const p = await api("batch.preview", { config: config() });
  if (rev !== revision) throw Error("设置已经改变，请重新预览");
  previewId = p.previewId;
  $("preview-result").hidden = false;
  $("preview-result").textContent =
    `${p.network.name} / ${p.wallets.filter((w) => w.ready).length} 个可用钱包\n每笔 value ${p.config.value} ${p.network.nativeSymbol} · 每钱包次数 ${p.perWalletCount}\n${p.wallets.map((w) => w.address + "：" + (w.ready ? (w.unresolved ? "存在结果未知交易，暂停新 nonce" : "就绪") : "不可用：" + w.error) + (w.data ? "\nGasLimit " + w.fees.gasLimit + " · " + w.fees.mode + " · 费率上限 " + (w.fees.mode === "Legacy" ? w.fees.gasPrice : w.fees.maxFee) + " gwei · 优先费 " + w.fees.maxPriorityFee + " gwei\n数据 " + w.data.slice(0, 200) : "")).join("\n")}\n配置 SHA-256：${p.snapshotHash}\n${p.warning}`;
  return p;
}
$("preview").onclick = () => action(doPreview);
$("start").onclick = () =>
  action(async () => {
    if (!previewId) await doPreview();
    const id = previewId;
    previewId = null;
    invalidate.starting = true;
    try {
      await api("batch.start", { previewId: id });
      render(await api("app.info"));
    } finally {
      invalidate.starting = false;
    }
  });
$("stop").onclick = () =>
  action(async () => {
    await api("batch.stop");
    render(await api("app.info"));
  });
$("approve-mode").onchange = () => {
  $("approve-amount").disabled = $("approve-mode").value !== "amount";
};
function approval() {
  return {
    token: $("approve-token").value,
    to: $("target").value,
    mode: $("approve-mode").value,
    amount: $("approve-amount").value,
  };
}
function allowanceContext() {
  return JSON.stringify([state.network.chainId, networkRevision, approval(),
    state.wallets.map(w => w.address)]);
}
function beginAllowance() {
  return { revision: ++allowanceRevision, context: allowanceContext() };
}
function currentAllowance(request) {
  return request.revision === allowanceRevision && request.context === allowanceContext();
}
for (const id of ["target", "approve-token", "approve-mode", "approve-amount"])
  $(id).addEventListener("input", () => {
    allowanceRevision++;
    $("allowance-result").textContent = "";
  });
$("authorize").onclick = () =>
  action(async () => {
    const b = $("authorize");
    const request = beginAllowance();
    b.disabled = true;
    try {
      const r = await api("approval.send", approval());
      if (!currentAllowance(request)) return;
      $("allowance-result").textContent = r.cancelled
        ? "已取消"
        : r.results
            .map(
              (w) =>
                w.address.slice(0, 10) +
                "：" +
                (w.success ? "授权额度已验证" : w.error),
            )
            .join("；");
    } finally {
      b.disabled = false;
      render(await api("app.info"));
    }
  });
$("allowance-query").onclick = () =>
  action(async () => {
    const request = beginAllowance();
    const r = await api("approval.query", approval());
    if (!currentAllowance(request)) return;
    $("allowance-result").textContent =
      r.symbol +
      " · decimals " +
      (r.decimals ?? "未读取（额度按最小单位显示）") +
      "\n" +
      r.wallets
        .map(
          (w) =>
            w.address.slice(0, 10) +
            "：" +
            (w.error || w.allowance + " 最小单位"),
        )
        .join("；");
  });
$("refresh").onclick = () =>
  action(async () => render(await api("journal.refresh")));
$("export-records").onclick = () => action(() => api("journal.export"));
async function loadRecords(delta) {
  const chain = state.network.chainId, rev = networkRevision;
  const requested = page = Math.max(0, page + delta);
  try {
    const rows = await api("journal.query", { offset: requested * 100 });
    if (rev !== networkRevision || chain !== state.network.chainId || page !== requested) return;
    loadRecords.lastPage = requested;
    renderRecords(rows);
  } catch (error) {
    if (rev !== networkRevision || chain !== state.network.chainId || page !== requested) return;
    page = loadRecords.lastPage || 0;
    throw error;
  }
}
$("records-next").onclick = () => action(() => loadRecords(1));
$("records-prev").onclick = () => action(() => loadRecords(-1));
window.desktop.onEvent((e) => {
  if (e.type === "state") {
    const now = Date.now();
    if (now - lastStateAt > 200) {
      clearTimeout(window.stateRenderTimer);
      window.stateRenderTimer = null;
      lastStateAt = now;
      render(e.value);
    } else {
      window.pendingState = e.value;
      if (!window.stateRenderTimer)
        window.stateRenderTimer = setTimeout(
          () => {
            window.stateRenderTimer = null;
            lastStateAt = Date.now();
            render(window.pendingState);
          },
          Math.max(1, 200 - (now - lastStateAt)),
        );
    }
  } else if (e.type === "log" && state) {
    state.logs.push(e.item);
    if (state.logs.length > 200) state.logs.shift();
    $("logs").textContent = state.logs
      .map((l) => `${l.time.slice(11, 19)} ${l.message}`)
      .join("\n");
  }
});
function clearWalletSecrets() {
  walletDraft = [];
  draftDirty = false;
  for (const input of $("wallet-dialog").querySelectorAll(
    'input[type="password"]',
  ))
    input.value = "";
  $("paste-keys").value = "";
  $("export-private").checked = false;
}
$("wallet-dialog").addEventListener("cancel", clearWalletSecrets);
$("wallet-dialog").addEventListener("close", () => {
  // close events are queued: an older close must not clear a reopened draft.
  if ($("wallet-dialog").open) return;
  clearWalletSecrets();
});
action(async () => render(await api("app.info")));
