"use strict";
const defaults = [
  {
    chainId: "8453",
    name: "Base",
    nativeSymbol: "ETH",
    decimals: 18,
    explorer: "https://basescan.org",
    gasMode: "eip1559",
  },
  {
    chainId: "1",
    name: "Ethereum",
    nativeSymbol: "ETH",
    decimals: 18,
    explorer: "https://etherscan.io",
    gasMode: "eip1559",
  },
  {
    chainId: "56",
    name: "BSC",
    nativeSymbol: "BNB",
    decimals: 18,
    explorer: "https://bscscan.com",
    gasMode: "legacy",
  },
  {
    chainId: "4663",
    name: "Robinhood Chain",
    nativeSymbol: "ETH",
    decimals: 18,
    explorer: "https://robinhoodchain.blockscout.com",
    gasMode: "eip1559",
  },
  {
    chainId: "137",
    name: "Polygon",
    nativeSymbol: "POL",
    decimals: 18,
    explorer: "https://polygonscan.com",
    gasMode: "eip1559",
  },
  {
    chainId: "43114",
    name: "Avalanche C-Chain",
    nativeSymbol: "AVAX",
    decimals: 18,
    explorer: "https://explorer.avax.network/c-chain",
    gasMode: "eip1559",
  },
];
function chainId(value) {
  const s = String(value ?? "");
  if (!/^[1-9]\d{0,77}$/.test(s) || BigInt(s) > 2n ** 256n - 1n)
    throw Error("Chain ID 必须是正整数");
  return BigInt(s).toString();
}
function network(raw) {
  const id = chainId(raw.chainId),
    name = String(raw.name || "").trim(),
    nativeSymbol = String(raw.nativeSymbol || "").trim();
  if (!name || name.length > 80 || !/^[-A-Za-z0-9]{1,16}$/.test(nativeSymbol))
    throw Error("网络名称或原生币符号无效");
  const decimals = Number(raw.decimals ?? 18);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36)
    throw Error("原生币精度必须为 0–36");
  let explorer = "";
  if (raw.explorer) {
    const u = new URL(raw.explorer);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash
    )
      throw Error("浏览器地址必须为不带认证参数的 HTTPS 地址");
    explorer = u.toString().replace(/\/$/, "");
  }
  return {
    chainId: id,
    name,
    nativeSymbol,
    decimals,
    explorer,
    gasMode: raw.gasMode === "legacy" ? "legacy" : "eip1559",
  };
}
module.exports = {
  defaults,
  chainId,
  network,
  forChain: (id) => ({ chainId: chainId(id) }),
};
