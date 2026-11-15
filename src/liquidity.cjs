"use strict";
const { Interface } = require("ethers");
const SEC=require("./listener-security.cjs");
const iface = new Interface([
  "function addLiquidity(address tokenA,address tokenB,uint256 amountADesired,uint256 amountBDesired,uint256 amountAMin,uint256 amountBMin,address to,uint256 deadline)",
  "function addLiquidityETH(address token,uint256 amountTokenDesired,uint256 amountTokenMin,uint256 amountETHMin,address to,uint256 deadline)",
]);
const lower = (s) => String(s || "").toLowerCase();
function actions(config, tx) {
  if (
    !config.sniffAddLiquidity ||
    lower(tx.to) !== lower(config.routerAddress) ||
    (config.addlper && lower(tx.from) !== lower(config.addlper))
  )
    return [];
  try {
    const r = iface.parseTransaction({ data: tx.input || tx.data });
    if (
      r?.name === "addLiquidity" &&
      r.args.amountADesired > 0n &&
      r.args.amountBDesired > 0n
    )
      return [{ action: r.name, tokens: [r.args.tokenA, r.args.tokenB] }];
    if (
      r?.name === "addLiquidityETH" &&
      r.args.amountTokenDesired > 0n &&
      BigInt(tx.value ?? 0) > 0n
    )
      return [{ action: r.name, tokens: [r.args.token] }];
  } catch {}
  return [];
}
function matches(config, a) {
  return (a.tokens || []).some((t) => lower(t) === lower(config.tokenAddress));
}
function verified(tx,chainId){return !!SEC.signed(tx,chainId??8453);}

module.exports = { actions, matches, verified, iface };
