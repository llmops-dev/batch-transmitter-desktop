"use strict";
const fs = require("node:fs"),
  path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const encodeJSON = (o) =>
  JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
class Journal {
  constructor(file, codec = { encode: (s) => s, decode: (s) => s }) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.codec = codec;
    this.db = new DatabaseSync(file);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS tx(hash TEXT PRIMARY KEY,chain TEXT NOT NULL,wallet TEXT NOT NULL,nonce INTEGER NOT NULL,task TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,accepted INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,payload TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS tx_nonce ON tx(chain,wallet,nonce) WHERE status != 'cancelled'; CREATE INDEX IF NOT EXISTS tx_open ON tx(chain,wallet,status,nonce); CREATE INDEX IF NOT EXISTS tx_task ON tx(task,created); CREATE INDEX IF NOT EXISTS tx_created ON tx(created); CREATE INDEX IF NOT EXISTS tx_task_wallet ON tx(task,wallet,kind,status);",
    );
    for (const r of this.db
      .prepare("SELECT * FROM tx WHERE status='prepared'")
      .all())
      this.update({ ...this.row(r), status: "unknown" });
  }
  encode(o) {
    return this.codec.encode(encodeJSON(o));
  }
  decode(s) {
    return JSON.parse(this.codec.decode(s));
  }
  getSetting(k, fallback) {
    const row = this.db
      .prepare("SELECT payload FROM settings WHERE key=?")
      .get(k);
    return row ? this.decode(row.payload) : fallback;
  }
  setting(k, v) {
    this.db
      .prepare(
        "INSERT INTO settings(key,payload) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload",
      )
      .run(k, this.encode(v));
  }
  row(r) {
    const p = this.decode(r.payload);
    if (
      p.hash !== r.hash ||
      String(p.chainId) !== r.chain ||
      p.from.toLowerCase() !== r.wallet ||
      p.nonce !== r.nonce ||
      p.taskId !== r.task ||
      p.kind !== r.kind ||
      p.status !== r.status ||
      Number(!!p.accepted) !== r.accepted ||
      p.createdAt !== r.created
    )
      throw Error("事务日志索引与加密记录不一致，请保留原文件并恢复备份");
    return p;
  }
  effect(r) {
    const o = {
      signed: 1,
      accepted: Number(!!r.accepted),
      pending: Number(
        [
          "pending",
          "prepared",
          "mined-success",
          "mined-revert",
          "fee-unknown",
        ].includes(r.status),
      ),
      unknown: Number(r.status === "unknown"),
      success: Number(r.status === "confirmed"),
      reverted: Number(r.status === "reverted"),
      cancelled: Number(r.status === "cancelled"),
      executionFee: r.executionFee || "0",
      spentValue: ["confirmed", "mined-success"].includes(r.status)
        ? r.value
        : "0",
    };
    return o;
  }
  statChange(old, r) {
    for (const key of [
      "totals:" + r.taskId,
      "wallet-totals:" + r.taskId + ":" + r.from.toLowerCase(),
    ])
      this.statAt(key, old, r);
  }
  statAt(key, old, r) {
    const t = this.getSetting(key, {
        signed: 0,
        accepted: 0,
        pending: 0,
        unknown: 0,
        success: 0,
        reverted: 0,
        cancelled: 0,
        executionFee: "0",
        spentValue: "0",
      }),
      a = old ? this.effect(old) : {},
      b = this.effect(r);
    for (const k of Object.keys(b))
      t[k] =
        typeof b[k] === "string"
          ? (BigInt(t[k] || 0) + BigInt(b[k]) - BigInt(a[k] || 0)).toString()
          : t[k] + b[k] - (a[k] || 0);
    this.setting(key, t);
  }
  atomic(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  add(r) {
    return this.atomic(() => {
      const prior = this.get(r.hash);
      if (prior) {
        if (prior.status !== "cancelled") throw Error("已有同哈希交易记录");
        for (const k of [
          "totals:" + prior.taskId,
          "wallet-totals:" + prior.taskId + ":" + prior.from.toLowerCase(),
        ]) {
          const t = this.getSetting(k, {}),
            effect = this.effect(prior);
          for (const name of Object.keys(effect))
            t[name] =
              typeof effect[name] === "string"
                ? (BigInt(t[name] || 0) - BigInt(effect[name])).toString()
                : (t[name] || 0) - effect[name];
          this.setting(k, t);
        }
        this.db.prepare("DELETE FROM tx WHERE hash=?").run(r.hash);
      }
      this.db
        .prepare(
          "INSERT INTO tx(hash,chain,wallet,nonce,task,kind,status,accepted,created,payload) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          r.hash,
          String(r.chainId),
          r.from.toLowerCase(),
          r.nonce,
          r.taskId,
          r.kind,
          r.status,
          Number(r.accepted || false),
          r.createdAt,
          this.encode(r),
        );
      this.statChange(null, r);
    });
  }
  get(hash) {
    const r = this.db
      .prepare("SELECT * FROM tx WHERE hash=?")
      .get(hash.toLowerCase());
    return r ? this.row(r) : null;
  }
  update(r) {
    return this.atomic(() => {
      const old = this.get(r.hash);
      if (
        !old ||
        old.chainId !== r.chainId ||
        old.from !== r.from ||
        old.nonce !== r.nonce ||
        old.taskId !== r.taskId
      )
        throw Error("记录身份不可改变");
      this.db
        .prepare("UPDATE tx SET status=?,accepted=?,payload=? WHERE hash=?")
        .run(r.status, Number(r.accepted || false), this.encode(r), r.hash);
      this.statChange(old, r);
    });
  }
  *open(chain, address) {
    const params = [String(chain)];
    let q =
      "SELECT * FROM tx WHERE chain=? AND status IN ('prepared','pending','unknown','fee-unknown','mined-success','mined-revert')";
    if (address) {
      q += " AND wallet=?";
      params.push(address.toLowerCase());
    }
    q += " ORDER BY nonce";
    for (const r of this.db.prepare(q).iterate(...params)) yield this.row(r);
  }
  highNonce(chain, address) {
    const r = this.db
      .prepare(
        "SELECT MAX(nonce) n FROM tx WHERE chain=? AND wallet=? AND status!='cancelled'",
      )
      .get(String(chain), address.toLowerCase());
    return r.n ?? -1;
  }
  *sinceNonce(chain, address, nonce) {
    for (const r of this.db
      .prepare(
        "SELECT * FROM tx WHERE chain=? AND wallet=? AND nonce>=? AND status!='cancelled' ORDER BY nonce",
      )
      .iterate(String(chain), address.toLowerCase(), nonce))
      yield this.row(r);
  }
  openPage(chain, after = 0, limit = 32) {
    return this.db
      .prepare(
        "SELECT rowid seq,* FROM tx WHERE chain=? AND rowid>? AND status IN ('prepared','pending','unknown','fee-unknown','mined-success','mined-revert') ORDER BY rowid LIMIT ?",
      )
      .all(String(chain), after, limit)
      .map((r) => ({ ...this.row(r), seq: r.seq }));
  }
  count(task, address) {
    return this.db
      .prepare(
        "SELECT COUNT(*) n FROM tx WHERE task=? AND wallet=? AND kind='call' AND status!='cancelled'",
      )
      .get(task, address.toLowerCase()).n;
  }
  totals(task) {
    return this.getSetting("totals:" + task, {
      signed: 0,
      accepted: 0,
      pending: 0,
      unknown: 0,
      success: 0,
      reverted: 0,
      cancelled: 0,
      executionFee: "0",
      spentValue: "0",
    });
  }
  walletTotals(task, address) {
    return this.getSetting(
      "wallet-totals:" + task + ":" + address.toLowerCase(),
      {},
    );
  }
  page(chain, limit = 100, offset = 0) {
    return this.db
      .prepare(
        "SELECT * FROM tx WHERE chain=? ORDER BY created DESC,rowid DESC LIMIT ? OFFSET ?",
      )
      .all(
        String(chain),
        Math.min(200, Math.max(1, limit)),
        Math.max(0, offset),
      )
      .map((r) => this.public(this.row(r)));
  }
  public(r) {
    const { raw, tx, rpcAttempts, ...p } = r;
    return p;
  }
  close() {
    this.db.close();
  }
}
module.exports = { Journal, encodeJSON };
