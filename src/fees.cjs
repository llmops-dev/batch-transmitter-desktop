"use strict";
const { Interface, Transaction } = require("ethers");
const { receiptFee } = require("./receipt-security.cjs");
const oracle = "0x420000000000000000000000000000000000000F";
const abi = new Interface([
  "function getL1FeeUpperBound(uint256) view returns(uint256)",
]);
async function extraReserve(pool, tx, chainId) {
  if (String(chainId) !== "8453") return 0n;
  const unsigned = Transaction.from(tx).unsignedSerialized;
  const value = await pool.read("call", {
    to: oracle,
    data: abi.encodeFunctionData("getL1FeeUpperBound", [
      (unsigned.length - 2) / 2,
    ]),
  });
  let fee;
  try {
    fee = abi.decodeFunctionResult("getL1FeeUpperBound", value)[0];
  } catch {
    throw Error("无法读取 Base L1 费用，拒绝漏算费用后广播");
  }
  return fee * 2n;
}
async function actualFee(pool, receipt, record) {
  const execution = receiptFee(receipt, record);
  if (execution === null) return null;
  if (String(record.chainId) !== "8453") return execution;
  const raw = await pool.read("send", "eth_getTransactionReceipt", [
    record.hash,
  ]);
  if (
    !raw ||
    String(raw.transactionHash).toLowerCase() !== record.hash.toLowerCase() ||
    String(raw.blockHash).toLowerCase() !== receipt.blockHash.toLowerCase()
  )
    return null;
  try {
    if (typeof raw.l1Fee !== "string" || !/^0x[0-9a-f]{1,64}$/i.test(raw.l1Fee))
      return null;
    const extra = BigInt(raw.l1Fee);
    if (extra > BigInt(record.reserveExtraFee ?? 0)) return null;
    return execution + extra;
  } catch {
    return null;
  }
}
module.exports = { extraReserve, actualFee, oracle, abi };
