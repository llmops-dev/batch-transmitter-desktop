"use strict";
const { getAddress, Wallet } = require("ethers");
const { addr, units, integer, rpcUrl } = require("./runtime.cjs");
function template(value) {
  let s = String(value ?? "").trim() || "0x";
  if (s.length > 262146 || !/^0x/i.test(s))
    throw Error("calldata 必须以 0x 开头，最大 128 KiB");
  s = "0x" + s.slice(2);
  const test = s
    .replaceAll("(address32)", "0".repeat(64))
    .replaceAll("(address)", "0".repeat(40));
  if (test.length > 262146)
    throw Error("地址替换后的 calldata 超过 128 KiB");
  if (!/^0x(?:[0-9a-f]{2})*$/i.test(test))
    throw Error(
      "calldata 必须为完整字节的十六进制，仅支持 (address) 和 (address32)",
    );
  return s;
}
function expand(data, address) {
  return template(data)
    .replaceAll(
      "(address32)",
      getAddress(address).slice(2).toLowerCase().padStart(64, "0"),
    )
    .replaceAll("(address)", getAddress(address).slice(2).toLowerCase())
    .toLowerCase();
}
function profile(raw, address) {
  const p = {
    address: addr(address),
    rpc: rpcUrl(raw.rpc),
    gasPrice: String(raw.gasPrice ?? "5"),
    gasLimit: String(raw.gasLimit ?? "2000000"),
    eip1559:
      raw.eip1559 === true || raw.eip1559 === 1 || raw.eip1559 === "true",
    maxFee: String(raw.maxFee ?? "5"),
    maxPriorityFee: String(raw.maxPriorityFee ?? "0.1"),
  };
  const limit = units(p.gasLimit, 0);
  if (limit < 21000n || limit > 300000000n)
    throw Error("GasLimit 必须为 21000–300000000");
  for (const k of ["gasPrice", "maxFee", "maxPriorityFee"]) units(p[k], 9, k);
  if (p.eip1559) {
    if (
      units(p.maxFee, 9) === 0n ||
      units(p.maxPriorityFee, 9) > units(p.maxFee, 9)
    )
      throw Error("MaxFee 必须大于 0 且不低于 MaxPriorityFee");
  } else if (units(p.gasPrice, 9) === 0n)
    throw Error("GasPrice 必须大于 0；Gas 跟随在监听规则中设置");
  return p;
}
function rows(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 500)
    throw Error("请导入 1–500 个钱包");
  const seen = new Set(),
    out = [],
    errors = [];
  for (let i = 0; i < raw.length; i++) {
    try {
      const r = raw[i];
      if (
        typeof r.privatekey !== "string" ||
        !/^(0x)?[0-9a-f]{64}$/i.test(r.privatekey.trim())
      )
        throw Error("私钥格式无效");
      const w = new Wallet("0x" + r.privatekey.trim().replace(/^0x/i, ""));
      if (seen.has(w.address.toLowerCase())) throw Error("钱包重复");
      seen.add(w.address.toLowerCase());
      out.push({ key: w.privateKey, profile: profile(r, w.address) });
    } catch (e) {
      errors.push({
        row: raw[i]?.row ?? i + 1,
        error: String(e.message).slice(0, 160),
      });
    }
  }
  if (errors.length) {
    const e = Error(
      "导入未生效：" +
        errors
          .map((x) => `第 ${x.row} 行 ${x.error}`)
          .join("；")
          .slice(0, 450),
    );
    e.rows = errors;
    throw e;
  }
  return out;
}
function config(raw, network) {
  const c = {
    chainId: network.chainId,
    to: addr(raw.to, "接收地址"),
    data: template(raw.data),
    value: String(raw.value ?? "0"),
    count: integer(raw.count ?? 0, 0, 1e9, "每钱包发送次数"),
    intervalMs: integer(raw.intervalMs ?? 1000, 1, 3600000, "间隔"),
    concurrency: integer(raw.concurrency ?? 4, 1, 500, "并发"),
    rps: integer(raw.rps ?? 20, 1, 1000, "节点请求频率"),
    mode: raw.mode || "block",
    startBlock: String(raw.startBlock ?? "0"),
    startTime: raw.startTime || "",
    probeIntervalMs: integer(
      raw.probeIntervalMs ?? 500,
      50,
      3600000,
      "嗅探间隔",
    ),
    delaySeconds: integer(raw.delaySeconds ?? 0, 0, 86400, "延迟"),
    durationMinutes: integer(raw.durationMinutes ?? 0, 0, 525600, "有效期"),
    valueBudget: String(raw.valueBudget ?? "0"),
    feeBudget: String(raw.feeBudget ?? "0"),
    subscribeRpc: raw.subscribeRpc ? rpcUrl(raw.subscribeRpc, true) : "",
    sniffAddLiquidity: raw.sniffAddLiquidity === true,
    addlper: raw.addlper ? addr(raw.addlper) : "",
    routerAddress: raw.routerAddress ? addr(raw.routerAddress) : "",
    tokenAddress: raw.tokenAddress ? addr(raw.tokenAddress) : "",
    followLiquidityGas: raw.followLiquidityGas === true,
    customActions: [],
  };
  for (const k of ["value", "valueBudget", "feeBudget"])
    units(c[k], network.decimals, k);
  units(c.startBlock, 0);
  if (!["block", "time", "probe", "listen"].includes(c.mode))
    throw Error("启动方式无效");
  if (
    c.mode === "time" &&
    (!c.startTime || !Number.isFinite(Date.parse(c.startTime)))
  )
    throw Error("请输入完整开始日期和时间");
  if (c.mode === "listen" && !c.subscribeRpc)
    throw Error("监听模式需要 WSS 节点");
  if (c.sniffAddLiquidity && (!c.routerAddress || !c.tokenAddress))
    throw Error("加池监听需要 Router 与 Token 地址");
  if ((raw.customActions || []).length > 100)
    throw Error("最多 100 条监听规则");
  for (const r of raw.customActions || []) {
    const q = {
      from: r.from ? addr(r.from) : "",
      to: r.to ? addr(r.to) : "",
      selector: String(r.selector || "").toLowerCase(),
      match: r.match === "contains" ? "contains" : "selector",
      gasPriceGwei: String(r.gasPriceGwei ?? "0"),
    };
    if (!q.from && !q.to && !q.selector)
      throw Error("监听规则至少填写一个匹配条件");
    if (
      q.selector &&
      !(
        q.match === "selector"
          ? /^0x[0-9a-f]{8}$/
          : /^0x(?:[0-9a-f]{2}){1,4096}$/
      ).test(q.selector)
    )
      throw Error("监听动作十六进制格式无效");
    units(q.gasPriceGwei, 9);
    c.customActions.push(q);
  }
  if (c.mode === "listen" && !c.sniffAddLiquidity && !c.customActions.length)
    throw Error("请添加监听规则或启用加池监听");
  return c;
}
module.exports = { template, expand, profile, rows, config };
