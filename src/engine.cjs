"use strict";
const crypto = require("node:crypto");
const {
  Transaction,
  keccak256,
  Interface,
  formatUnits,
  MaxUint256,
} = require("ethers");
const {
  RpcPool,
  units,
  addr,
  integer,
  cleanError,
  timeout,
} = require("./runtime.cjs");
const NETWORK = require("./config.cjs");
const POLICY = require("./policy.cjs");
const { Monitor } = require("./monitor.cjs");
const {
  validateReceipt,
  validateRecoveredTransaction,
  receiptFee,
} = require("./receipt-security.cjs");
const ERC20 = new Interface([
  "function decimals() view returns(uint8)",
  "function symbol() view returns(string)",
  "function allowance(address,address) view returns(uint256)",
  "function approve(address,uint256) returns(bool)",
]);
const open = new Set([
  "prepared",
  "pending",
  "unknown",
  "fee-unknown",
  "mined-success",
  "mined-revert",
]);
async function mapLimit(items, n, fn) {
  let index = 0;
  const out = [];
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = index++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}
const clone = (x) => structuredClone(x);
class Engine {
  constructor({
    vault,
    journal,
    poolFactory,
    feeEstimator = require("./fees.cjs").extraReserve,
    feeReader = require("./fees.cjs").actualFee,
    confirm = async () => true,
    onEvent = () => {},
  }) {
    this.vault = vault;
    this.journal = journal;
    this.feeEstimator = feeEstimator;
    this.feeReader = feeReader;
    this.poolFactory = poolFactory;
    this.confirm = confirm;
    this.emit = onEvent;
    this.state = journal.getSetting("state", {
      selected: "8453",
      networks: NETWORK.defaults,
      profiles: {},
      configs: {},
    });
    // Existing profiles must also acquire new built-ins. Append missing IDs;
    // preserve user-defined networks, selection, RPCs, configs and journal.
    const missing = NETWORK.defaults.filter(
      (n) => !this.state.networks.some((saved) => saved.chainId === n.chainId),
    );
    if (missing.length) {
      const next = {
        ...this.state,
        networks: [...this.state.networks, ...missing.map((n) => ({ ...n }))],
      };
      journal.setting("state", next);
      this.state = next;
    }
    this.network =
      this.state.networks.find((n) => n.chainId === this.state.selected) ||
      NETWORK.defaults[0];
    this.pools = new Map();
    this.ops = new Set();
    this.generation = 0;
    this.busy = false;
    this.pollBusy = false;
    this.pollCursor = 0;
    this.previews = new Map();
    this.run = null;
    this.task = { status: "idle", reason: "程序重启后不会自动恢复发送" };
    this.logs = [];
    this.timer = setInterval(
      () => this.poll().catch((e) => this.log(e, "warn")),
      1500,
    );
    this.timer.unref?.();
  }
  log(value, level = "info") {
    const item = {
      time: new Date().toISOString(),
      level,
      message: cleanError(value),
    };
    this.logs.push(item);
    if (this.logs.length > 200) this.logs.shift();
    this.emit({ type: "log", item });
  }
  profiles() {
    return this.state.profiles[this.network.chainId] || [];
  }
  info() {
    const taskOnChain = !this.run || this.run.network.chainId === this.network.chainId;
    return {
      stateRevision: (this.stateRevision = (this.stateRevision || 0) + 1),
      version: require("../package.json").version,
      network: this.network,
      networks: this.state.networks,
      wallets: this.profiles().map((p) => ({
        ...p,
        loaded: this.vault.has(p.address),
        counters: taskOnChain && this.task.id
          ? this.journal.walletTotals(this.task.id, p.address)
          : {},
      })),
      vault: this.vault.info(),
      config: this.state.configs[this.network.chainId] || {},
      task: {
        ...this.task,
        chainId: this.run?.network.chainId || this.network.chainId,
        networkName: this.run?.network.name || this.network.name,
        counters: taskOnChain && this.task.id ? this.journal.totals(this.task.id) : {},
      },
      journal: this.journal.page(this.network.chainId),
      logs: this.logs,
    };
  }
  save() {
    this.journal.setting("state", this.state);
  }
  publish() {
    if (this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      try {
        this.emit({ type: "state", value: this.info() });
      } catch (e) {
        this.log(e, "error");
      }
    }, 100);
    this.publishTimer.unref?.();
  }
  async change(fn) {
    if (this.busy) throw Error("设置操作正在进行");
    this.busy = true;
    try {
      await this.stop("设置已改变");
      this.previews.clear();
      return await fn();
    } finally {
      this.busy = false;
      this.publish();
    }
  }
  async select(id) {
    return this.change(async () => {
      id = NETWORK.chainId(id);
      const n = this.state.networks.find((n) => n.chainId === id);
      if (!n) throw Error("网络不存在");
      const next = { ...this.state, selected: id };
      this.journal.setting("state", next);
      this.state = next;
      this.network = n;
      for (const p of this.pools.values()) p.destroy();
      this.pools.clear();
      this.pollCursor = 0;
      return this.info();
    });
  }
  async saveNetwork(raw) {
    return this.change(async () => {
      const n = NETWORK.network(raw);
      const next = clone(this.state);
      next.networks = next.networks.filter((x) => x.chainId !== n.chainId);
      next.networks.push(n);
      this.journal.setting("state", next);
      this.state = next;
      if (n.chainId === this.network.chainId) this.network = n;
      for (const p of this.pools.values()) p.destroy();
      this.pools.clear();
      return n;
    });
  }
  async importRows(raw) {
    return this.change(async () => {
      if (!Array.isArray(raw) || !raw.length || raw.length > 500)
        throw Error("请导入 1–500 个钱包");
      const enriched = raw.map((r) => ({
        ...r,
        privatekey: r.privatekey || this.vault.getSigner(r.address).privateKey,
      }));
      const valid = POLICY.rows(enriched);
      for (let i = 0; i < raw.length; i++)
        if (raw[i].address && addr(raw[i].address) !== valid[i].profile.address)
          throw Error("私钥与钱包地址不匹配");
      const before = new Set(this.vault.list().map((w) => w.address));
      const next = clone(this.state),
        profiles = new Map(
          this.profiles().map((p) => [p.address.toLowerCase(), p]),
        );
      for (const r of valid)
        profiles.set(r.profile.address.toLowerCase(), r.profile);
      next.profiles[this.network.chainId] = [...profiles.values()];
      const result = this.vault.import(valid.map((x) => x.key).join("\n"));
      try {
        this.journal.setting("state", next);
      } catch (e) {
        for (const r of valid)
          if (!before.has(r.profile.address))
            this.vault.remove(r.profile.address);
        throw e;
      }
      this.state = next;
      return { ...result, wallets: this.info().wallets };
    });
  }
  async removeWallet(address) {
    return this.change(async () => {
      address = addr(address);
      if (!this.vault.has(address)) throw Error("请先解锁钱包");
      const next = clone(this.state);
      for (const id of Object.keys(next.profiles))
        next.profiles[id] = next.profiles[id].filter(
          (p) => p.address !== address,
        );
      this.journal.setting("state", next);
      this.vault.remove(address);
      this.state = next;
      return this.info();
    });
  }
  async poolFor(profile, rps = null, generation = this.generation) {
    const key = this.network.chainId + "|" + profile.rpc;
    if (this.pools.has(key)) {
      const existing = this.pools.get(key);
      if (rps != null) existing.setRate?.(rps);
      return existing;
    }
    const p = this.poolFactory
      ? await this.poolFactory(profile, this.network)
      : new RpcPool({
          chainId: this.network.chainId,
          rps: rps ?? 20,
          onError: (e) => this.log(e, "warn"),
        });
    if (!this.poolFactory) {
      await p.connect([profile.rpc]);
      p.installLimiters();
    }
    if (generation !== this.generation) {
      p.destroy();
      throw Error("连接结果已过期");
    }
    if (this.pools.has(key)) {
      p.destroy();
      return this.pools.get(key);
    }
    this.pools.set(key, p);
    return p;
  }
  async refreshWallet(w) {
    const block = await w.pool.read("getBlockNumber");
    const [balance, latest, pending] = await Promise.all([
      w.pool.read("getBalance", w.profile.address, block),
      w.pool.read("getTransactionCount", w.profile.address, block),
      w.pool.read("getTransactionCount", w.profile.address, "pending"),
    ]);
    if (
      !Number.isSafeInteger(latest) ||
      !Number.isSafeInteger(pending) ||
      latest < 0 ||
      pending < latest
    )
      throw Error("节点 nonce 返回无效");
    let reserved = 0n,
      unresolved = false;
    for (const r of this.journal.sinceNonce(
      this.network.chainId,
      w.profile.address,
      latest,
    )) {
      if (["prepared", "unknown"].includes(r.status)) unresolved = true;
      reserved +=
        BigInt(r.executionFee ?? r.reserveFee) +
        (["reverted", "mined-revert"].includes(r.status)
          ? 0n
          : BigInt(r.value));
    }
    for (const r of this.journal.open(this.network.chainId, w.profile.address))
      if (["prepared", "unknown"].includes(r.status)) unresolved = true;
    w.balance = BigInt(balance);
    w.reserved = reserved;
    w.baseNonce = latest;
    w.nextNonce = Math.max(
      w.nextNonce ?? 0,
      pending,
      latest,
      this.journal.highNonce(this.network.chainId, w.profile.address) + 1,
    );
    w.unknown = unresolved;
    w.refreshed = Date.now();
  }
  async prepare(raw) {
    const generation = this.generation,
      c = POLICY.config(raw, this.network),
      selected = Array.isArray(raw.walletAddresses)
        ? new Set(raw.walletAddresses.map((x) => addr(x).toLowerCase()))
        : null;
    const profiles = this.profiles().filter(
      (p) => !selected || selected.has(p.address.toLowerCase()),
    );
    if (!profiles.length) throw Error("请导入并选择钱包");
    const wallets = await mapLimit(profiles, 4, async (p) => {
      const w = {
        profile: POLICY.profile(p, p.address),
        ready: false,
        nextAt: 0,
      };
      try {
        if (!this.vault.has(p.address)) throw Error("钱包未加载，请解锁保险库");
        w.pool = await this.poolFor(p, c.rps, generation);
        await this.refreshWallet(w);
        w.data = POLICY.expand(c.data, p.address);
        w.ready = true;
      } catch (e) {
        w.error = cleanError(e);
      }
      return w;
    });
    if (generation !== this.generation) throw Error("预览结果已过期");
    if (!wallets.some((w) => w.ready))
      throw Error(
        "所有钱包不可用：" +
          wallets
            .map((w) => w.error)
            .join("；")
            .slice(0, 400),
      );
    return {
      c,
      wallets,
      generation,
      network: clone(this.network),
      snapshotHash: crypto
        .createHash("sha256")
        .update(
          JSON.stringify({
            network: this.network,
            config: c,
            wallets: wallets.filter((w) => w.ready).map((w) => w.profile),
          }),
        )
        .digest("hex"),
    };
  }
  async preview(raw) {
    if (this.busy || this.ops.size || this.run?.active || this.approvalActive)
      throw Error("请先停止当前任务");
    const p = await this.prepare(raw);
    const id = crypto.randomUUID();
    this.previews.clear();
    this.previews.set(id, p);
    return {
      previewId: id,
      snapshotHash: p.snapshotHash,
      network: p.network,
      config: p.c,
      wallets: p.wallets.map((w) => ({
        address: w.profile.address,
        ready: w.ready,
        error: w.error || "",
        balance: w.ready ? formatUnits(w.balance, p.network.decimals) : null,
        data: w.data || "",
        fees: {
          gasLimit: w.profile.gasLimit,
          mode: w.profile.eip1559 ? "EIP-1559" : "Legacy",
          gasPrice: w.profile.gasPrice,
          maxFee: w.profile.maxFee,
          maxPriorityFee: w.profile.maxPriorityFee,
        },
        unresolved: w.unknown,
      })),
      perWalletCount: p.c.count || "不限",
      pendingLimit: "不限",
      warning: "成功和回滚后均继续发送；停止不能撤回已广播交易。",
    };
  }
  async start(id) {
    if (this.busy || this.ops.size || this.run?.active || this.approvalActive)
      throw Error("已有任务正在执行");
    this.busy = true;
    let startedRun;
    try {
      const p = this.previews.get(id);
      if (!p || p.generation !== this.generation)
        throw Error("预览已失效，请重新预览");
      this.previews.delete(id);
      if (
        !(await this.confirm(
          "batch",
          { ...p.c, snapshotHash: p.snapshotHash },
          p.network,
          p.wallets.filter((w) => w.ready).length,
        ))
      )
        return { cancelled: true };
      if (p.generation !== this.generation) throw Error("确认期间设置已改变");
      const run = {
        ...p,
        id: crypto.randomUUID(),
        active: true,
        started: Date.now(),
        gate: p.c.mode === "block" && BigInt(p.c.startBlock) === 0n,
        operations: new Set(),
        cursor: 0,
        reserveValue: 0n,
        reserveFee: 0n,
      };
      const next = clone(this.state);
      next.configs[this.network.chainId] = p.c;
      this.journal.setting("state", next);
      this.state = next;
      this.run = run;
      startedRun = run;
      this.task = {
        id: run.id,
        status: "waiting",
        mode: p.c.mode,
        reason: "等待启动条件",
        startedAt: new Date().toISOString(),
      };
      if (p.c.mode === "listen") {
        const pool = p.wallets.find((w) => w.ready).pool;
        run.monitor = new Monitor({
          url: p.c.subscribeRpc,
          pool,
          config: p.c,
          onMatch: (m) => {
            if (!this.allowed(run)) return;
            run.match = m;
            run.gateAt = Date.now() + p.c.delaySeconds * 1000;
            run.monitor.stop();
            this.log(m.reason);
          },
          onLog: (s, l) => this.log(s, l),
          onFatal: (e) => {
            this.stop(cleanError(e)).catch(() => {});
          },
        });
        await run.monitor.start();
      }
      if (!this.allowed(run)) {
        run.monitor?.stop();
        return this.task;
      }
      run.timer = setInterval(
        () =>
          this.tick(run).catch((e) => {
            this.log(e, "error");
            this.stop("发送引擎错误").catch(() => {});
          }),
        Math.min(100, p.c.intervalMs),
      );
      run.timer.unref?.();
      this.publish();
      await this.tick(run);
      return this.task;
    } catch (e) {
      if (startedRun && this.run === startedRun)
        await this.stop("启动失败：" + cleanError(e));
      throw e;
    } finally {
      this.busy = false;
    }
  }
  allowed(run) {
    return (
      run?.active &&
      this.run === run &&
      run.generation === this.generation &&
      (!run.c.durationMinutes ||
        Date.now() < run.started + run.c.durationMinutes * 60000)
    );
  }
  track(work, run) {
    this.ops.add(work);
    run?.operations.add(work);
    work
      .finally(() => {
        this.ops.delete(work);
        run?.operations.delete(work);
        if (run?.stopNew && run.operations.size === 0) run.active = false;
      })
      .catch(() => {});
    return work;
  }
  async tick(run = this.run) {
    if (run?.stopNew) return;
    if (!this.allowed(run)) {
      if (run?.active) this.stop("本地有效期已结束").catch(() => {});
      return;
    }
    if (run.ticking) return;
    run.ticking = true;
    try {
      const c = run.c;
      if (!run.gate && c.mode === "block") {
        const height = await run.wallets
          .find((w) => w.ready)
          .pool.read("getBlockNumber");
        if (BigInt(height) >= BigInt(c.startBlock)) run.gate = true;
      }
      if (
        !run.gate &&
        c.mode === "time" &&
        Date.now() >= Date.parse(c.startTime)
      )
        run.gate = true;
      if (
        !run.gate &&
        c.mode === "listen" &&
        run.gateAt != null &&
        Date.now() >= run.gateAt
      )
        run.gate = true;
      if (!this.allowed(run)) return;
      if (run.gate || c.mode === "probe") {
        this.task.status = "running";
        this.task.reason = "按次数持续发送";
        let room = c.concurrency - run.operations.size;
        for (let n = 0; n < run.wallets.length && room > 0; n++) {
          const w = run.wallets[run.cursor++ % run.wallets.length];
          if (
            !w.ready ||
            w.busy ||
            Date.now() < w.nextAt ||
            (c.count &&
              this.journal.count(run.id, w.profile.address) >= c.count)
          )
            continue;
          w.busy = true;
          room--;
          const work = this.sendWallet(run, w)
            .catch((e) => {
              this.log(e, "warn");
              w.error = cleanError(e);
              w.nextAt = Date.now() + 2000;
            })
            .finally(() => {
              w.busy = false;
            });
          this.track(work, run);
        }
      }
      if (
        c.count &&
        run.wallets
          .filter((w) => w.ready)
          .every(
            (w) => this.journal.count(run.id, w.profile.address) >= c.count,
          ) &&
        run.operations.size === 0
      ) {
        run.active = false;
        clearInterval(run.timer);
        run.monitor?.stop();
        this.task.status = "submitted";
        this.task.reason = "已达到发送次数，继续核对回执";
        this.publish();
      }
    } finally {
      run.ticking = false;
    }
  }
  fees(profile, match) {
    let mode = profile.eip1559 ? "eip1559" : "legacy",
      cap = units(profile.eip1559 ? profile.maxFee : profile.gasPrice, 9),
      priority = units(profile.maxPriorityFee, 9),
      price = units(profile.gasPrice, 9);
    if (match) {
      if (match.followGas) {
        const tx = match.tx;
        if (Number(tx.type) === 2 && profile.eip1559) {
          cap = [cap, BigInt(tx.maxFeePerGas)].reduce((a, b) =>
            a < b ? a : b,
          );
          priority = [priority, BigInt(tx.maxPriorityFeePerGas), cap].reduce(
            (a, b) => (a < b ? a : b),
          );
        } else {
          price = [cap, BigInt(tx.gasPrice ?? tx.maxFeePerGas)].reduce(
            (a, b) => (a < b ? a : b),
          );
          if (profile.eip1559) {
            cap = price;
            priority = priority < cap ? priority : cap;
          }
        }
      } else if (units(match.gasPriceGwei || "0", 9) > 0n) {
        const fixed = units(match.gasPriceGwei, 9);
        if (fixed > cap) throw Error("监听规则费率超过钱包费率上限");
        price = fixed;
        cap = fixed;
        priority = priority < cap ? priority : cap;
      }
    }
    return {
      cap,
      fields:
        mode === "eip1559"
          ? { type: 2, maxFeePerGas: cap, maxPriorityFeePerGas: priority }
          : { type: 0, gasPrice: price },
    };
  }
  async sendWallet(run, w) {
    if (!this.allowed(run) || run.stopNew) return;
    if (Date.now() - w.refreshed > 1500) await this.refreshWallet(w);
    if (!this.allowed(run)) return;
    if (w.unknown) {
      w.nextAt = Date.now() + 2000;
      const r = [
        ...this.journal.open(this.network.chainId, w.profile.address),
      ].find((r) => ["unknown", "prepared"].includes(r.status));
      if (r?.taskId === run.id)
        await this.retryRecord(r, () => this.allowed(run), w.pool);
      return;
    }
    if (run.c.mode === "probe" && !w.probed) {
      try {
        await w.pool.read("call", {
          from: w.profile.address,
          to: run.c.to,
          value: units(run.c.value, run.network.decimals),
          data: w.data,
          gasLimit: units(w.profile.gasLimit, 0),
          ...this.fees(w.profile, run.match).fields,
        });
        w.probed = true;
      } catch (e) {
        w.nextAt = Date.now() + run.c.probeIntervalMs;
        return;
      }
    }
    if (!this.allowed(run)) return;
    const tx = {
      chainId: BigInt(run.network.chainId),
      nonce: w.nextNonce,
      to: run.c.to,
      value: units(run.c.value, run.network.decimals),
      data: w.data,
      gasLimit: units(w.profile.gasLimit, 0),
      ...this.fees(w.profile, run.match).fields,
    };
    await this.submit(run, w, tx, "call", () => this.allowed(run));
    w.nextAt = Date.now() + run.c.intervalMs;
  }
  async submit(run, w, tx, kind, allowed) {
    if (!allowed()) return null;
    const extra = await this.feeEstimator(w.pool, tx, run.network.chainId);
    if (!allowed()) return null;
    const fee = tx.gasLimit * (tx.maxFeePerGas ?? tx.gasPrice) + extra,
      value = tx.value;
    if (w.balance - w.reserved < fee + value)
      throw Error("钱包余额不足以覆盖 value 和全部待确认交易的费用");
    if (run.c) {
      const vb = units(run.c.valueBudget, run.network.decimals),
        fb = units(run.c.feeBudget, run.network.decimals);
      if (
        (vb && run.reserveValue + value > vb) ||
        (fb && run.reserveFee + fee > fb)
      ) {
        run.stopNew = true;
        clearInterval(run.timer);
        this.task.status = "budget";
        this.task.reason = "达到本轮预算，停止新增交易";
        return null;
      }
    }
    w.reserved += fee + value;
    run.reserveValue += value;
    run.reserveFee += fee;
    let r,
      added = false;
    try {
      const raw = await this.vault
        .getSigner(w.profile.address)
        .signTransaction(tx);
      if (!allowed()) return null;
      const signed = Transaction.from(raw);
      if (
        signed.chainId !== BigInt(this.network.chainId) ||
        signed.from.toLowerCase() !== w.profile.address.toLowerCase() ||
        signed.to !== tx.to ||
        signed.data !== tx.data ||
        signed.value !== tx.value ||
        signed.nonce !== tx.nonce ||
        signed.gasLimit !== tx.gasLimit ||
        signed.type !== tx.type ||
        signed.gasPrice !== (tx.gasPrice ?? null) ||
        signed.maxFeePerGas !== (tx.maxFeePerGas ?? null) ||
        signed.maxPriorityFeePerGas !== (tx.maxPriorityFeePerGas ?? null)
      )
        throw Error("签名参数与任务不匹配");
      r = {
        hash: keccak256(raw),
        raw,
        tx: JSON.parse(
          JSON.stringify(tx, (_k, v) =>
            typeof v === "bigint" ? v.toString() : v,
          ),
        ),
        chainId: this.network.chainId,
        from: w.profile.address,
        to: tx.to,
        nonce: tx.nonce,
        value: String(value),
        data: tx.data,
        gasLimit: String(tx.gasLimit),
        feeCapWei: String(tx.maxFeePerGas ?? tx.gasPrice),
        reserveFee: String(fee),
        reserveExtraFee: String(extra),
        taskId: run.id,
        kind,
        status: "prepared",
        accepted: false,
        createdAt: Date.now(),
      };
      this.journal.add(r);
      added = true;
      w.nextNonce = tx.nonce + 1;
      let outcome;
      try {
        const result = await w.pool.broadcast(raw, 0, allowed);
        outcome = { accepted: true, attempts: result.attempts || [] };
      } catch (e) {
        outcome = { error: cleanError(e), attempts: e.attempts || [], cancelledBeforeSend: e.cancelledBeforeSend === true };
      }
      r = this.settleBroadcast(r.hash, outcome);
      if (r.status === "unknown") w.unknown = true;
      if (r.status === "cancelled") {
        w.nextNonce = tx.nonce;
        w.reserved -= fee + value;
        run.reserveValue -= value;
        run.reserveFee -= fee;
      }
      this.publish();
      return r;
    } catch (e) {
      if (added) {
        w.unknown = true;
        run.active = false;
        clearInterval(run.timer);
        this.task.status = "error";
        this.task.reason = "持久化失败，保留已签名交易，不再分配新 nonce";
      }
      throw e;
    } finally {
      if (!added) {
        w.reserved -= fee + value;
        run.reserveValue -= value;
        run.reserveFee -= fee;
      }
    }
  }
  settleBroadcast(hash, outcome) {
    // Polling may have verified a receipt while the send RPC was still waiting.
    // Merge only transport facts into the newest durable row. Never overwrite
    // a mined result or its accounted fee with an earlier prepared snapshot.
    const current = this.journal.get(hash);
    if (!current) throw Error("广播交易缺少持久化记录");
    current.rpcAttempts = outcome.attempts || [];
    if (outcome.error) current.error = outcome.error;
    else delete current.error;
    if (outcome.accepted) current.accepted = true;
    if (["prepared", "unknown", "pending"].includes(current.status)) {
      if (outcome.accepted || current.accepted) current.status = "pending";
      else if (outcome.cancelledBeforeSend && current.status === "prepared") current.status = "cancelled";
      else current.status = "unknown";
    }
    this.journal.update(current);
    return current;
  }
  async retryRecord(r, allowed, pool) {
    if (!allowed()) return;
    const tx = Transaction.from(r.raw);
    if (
      keccak256(r.raw) !== r.hash ||
      tx.chainId !== BigInt(r.chainId) ||
      tx.from !== r.from ||
      tx.to !== r.to ||
      tx.nonce !== r.nonce ||
      tx.data !== r.data ||
      tx.value !== BigInt(r.value)
    )
      throw Error("持久化签名记录不匹配");
    let outcome;
    try {
      const response = await pool.broadcast(r.raw, 0, allowed);
      outcome = { accepted: true, attempts: response.attempts || [] };
    } catch (e) {
      outcome = { error: cleanError(e), attempts: e.attempts || [] };
    }
    return this.settleBroadcast(r.hash, outcome);
  }
  async poll() {
    if (this.pollBusy || this.busy) return;
    this.pollBusy = true;
    const generation = this.generation;
    try {
      let page = this.journal.openPage(this.network.chainId, this.pollCursor);
      if (!page.length) {
        this.pollCursor = 0;
        return;
      }
      this.pollCursor = page.at(-1).seq;
      await mapLimit(page, 4, async (r) => {
        try {
          const p = this.profiles().find((p) => p.address === r.from);
          if (!p) return;
          const pool = await this.poolFor(p, null, generation);
          const receipt = await pool.receipt(r.hash, r);
          if (generation !== this.generation) return;
          r = this.journal.get(r.hash);
          if (!r || !open.has(r.status)) return;
          if (!receipt) {
            if (
              ["mined-success", "mined-revert", "fee-unknown"].includes(
                r.status,
              )
            ) {
              r.status = r.accepted ? "pending" : "unknown";
              delete r.blockNumber;
              delete r.blockHash;
              delete r.resultStatus;
              this.journal.update(r);
            }
            if (r.status === "unknown") {
              const tx = await pool.read("getTransaction", r.hash);
              if (generation !== this.generation) return;
              r = this.journal.get(r.hash);
              if (!r || !open.has(r.status)) return;
              if (tx) {
                validateRecoveredTransaction(tx, r.hash, r.chainId);
                r.accepted = true;
                if (["prepared", "unknown", "pending"].includes(r.status))
                  r.status = "pending";
                this.journal.update(r);
              }
            }
            return;
          }
          validateReceipt(receipt, r.hash, r);
          const block = await pool.read("getBlock", receipt.blockNumber);
          if (generation !== this.generation) return;
          if (
            !block ||
            String(block.hash).toLowerCase() !== receipt.blockHash.toLowerCase()
          )
            throw Error("回执不属于当前规范区块");
          const fee = await this.feeReader(pool, receipt, r),
            head = await pool.read("getBlockNumber");
          if (generation !== this.generation) return;
          // Conversely, a send response may arrive while this receipt lookup
          // is waiting. Retain its accepted flag and latest transport evidence.
          r = this.journal.get(r.hash);
          if (!r || !open.has(r.status)) return;
          r.blockNumber = receipt.blockNumber;
          r.blockHash = receipt.blockHash;
          r.resultStatus = receipt.status;
          r.status =
            fee === null
              ? "fee-unknown"
              : receipt.status === 1
                ? "mined-success"
                : "mined-revert";
          const accountFee =
            fee !== null &&
            r.executionFee == null &&
            head >= Number(receipt.blockNumber) + 1;
          if (accountFee) r.executionFee = String(fee);
          if (fee !== null && head >= Number(receipt.blockNumber) + 1)
            r.status = receipt.status === 1 ? "confirmed" : "reverted";
          // SQLite is the accounting authority. If COMMIT fails, retain the
          // full in-memory reservation; a later poll must not refund it twice.
          this.journal.update(r);
          if (accountFee) {
            const cap = BigInt(r.reserveFee);
            if (this.run?.id === r.taskId) {
              this.run.reserveFee += fee - cap;
              if (!receipt.status) this.run.reserveValue -= BigInt(r.value);
              const w = this.run.wallets.find(
                (w) => w.profile.address === r.from,
              );
              if (w && r.nonce >= w.baseNonce)
                w.reserved +=
                  fee - cap - (receipt.status ? 0n : BigInt(r.value));
            }
          }
        } catch (e) {
          this.log(e, "warn");
        }
      });
      if (generation === this.generation) this.publish();
    } finally {
      this.pollBusy = false;
    }
  }
  async diagnose(hash) {
    const generation = this.generation,
      r = this.journal.get(hash);
    if (!r || r.chainId !== this.network.chainId)
      throw Error("找不到当前链的交易记录");
    const urls = [...new Set(this.profiles().map((p) => p.rpc))].slice(0, 12);
    if (!urls.length) throw Error("没有当前链 RPC 配置");
    const pool = new RpcPool({ chainId: this.network.chainId, rps: 20 });
    try {
      await pool.connect(urls);
      if (generation !== this.generation) throw Error("查询已过期");
      const result = await pool.lookup(hash, r);
      if (generation !== this.generation) throw Error("查询已过期");
      return result;
    } finally {
      pool.destroy();
    }
  }
  async retry(hash) {
    return this.change(async () => {
      const r = this.journal.get(hash);
      if (
        !r ||
        r.chainId !== this.network.chainId ||
        !open.has(r.status) ||
        !this.vault.has(r.from)
      )
        throw Error("交易不能重试或钱包未加载");
      const generation = this.generation;
      if (!(await this.confirm("retry", r, this.network, 1)))
        return { cancelled: true };
      if (generation !== this.generation)
        throw Error("确认期间已停止，重发确认已过期");
      const p = this.profiles().find((p) => p.address === r.from);
      if (!p) throw Error("当前链缺少该钱包的 RPC 配置");
      // A retry is a real transport operation too. Stop must drain it before
      // settings, wallet locks or shutdown can finish.
      const work = (async () => {
        const pool = await this.poolFor(p, null, generation);
        if (generation !== this.generation)
          throw Error("重发操作已停止");
        await this.retryRecord(r, () => generation === this.generation, pool);
        return this.journal.public(this.journal.get(hash));
      })();
      return await this.track(work);
    });
  }
  async tokenInfo(token, pool, { requireDecimals = true } = {}) {
    token = addr(token);
    if ((await pool.read("getCode", token)) === "0x")
      throw Error("Token 地址没有合约代码");
    // Raw allowance reads, maximum approvals and revocations do not need
    // metadata. A hostile/broken decimals or symbol must not block recovery.
    if (!requireDecimals) return { token, decimals: null, symbol: "TOKEN" };
    let decimals = null,
      symbol = "TOKEN";
    try {
      decimals = Number(
        ERC20.decodeFunctionResult(
          "decimals",
          await pool.read("call", {
            to: token,
            data: ERC20.encodeFunctionData("decimals"),
          }),
        )[0],
      );
      if (decimals > 77) throw Error();
    } catch {
      throw Error("无法读取代币精度，拒绝猜测授权数量");
    }
    try {
      const raw = await pool.read("call", {
        to: token,
        data: ERC20.encodeFunctionData("symbol"),
      });
      if (raw.length > 4096) throw Error();
      symbol = String(ERC20.decodeFunctionResult("symbol", raw)[0]).slice(
        0,
        80,
      );
    } catch {}
    return { token, decimals, symbol };
  }
  async allowance(raw) {
    const generation = this.generation,
      to = addr(raw.to),
      token = addr(raw.token),
      profiles = this.profiles();
    if (!profiles.length) throw Error("请导入钱包");
    const pool = await this.poolFor(profiles[0]);
    const info = await this.tokenInfo(token, pool, { requireDecimals: false });
    const wallets = await mapLimit(profiles, 4, async (p) => {
      try {
        const rpc = await this.poolFor(p),
          data = await rpc.read("call", {
            to: token,
            data: ERC20.encodeFunctionData("allowance", [p.address, to]),
          });
        return {
          address: p.address,
          allowance: ERC20.decodeFunctionResult(
            "allowance",
            data,
          )[0].toString(),
        };
      } catch (e) {
        return { address: p.address, error: cleanError(e) };
      }
    });
    if (generation !== this.generation) throw Error("授权查询已过期");
    return { ...info, to, wallets };
  }
  async approve(raw) {
    if (this.busy || this.approvalActive)
      throw Error("另一个设置或授权操作正在执行");
    this.busy = true;
    try {
      await this.stop("开始批量授权");
      this.previews.clear();
      const generation = this.generation,
        network = clone(this.network),
        to = addr(raw.to),
        token = addr(raw.token),
        profiles = clone(this.profiles());
      if (!profiles.length) throw Error("请导入钱包");
      const pool = await this.poolFor(profiles[0]);
      const mode = raw.mode || "unlimited";
      if (!["unlimited", "amount", "revoke"].includes(mode))
        throw Error("授权方式无效");
      const info = await this.tokenInfo(token, pool, { requireDecimals: mode === "amount" }),
        amount =
          mode === "revoke"
            ? 0n
            : mode === "amount"
              ? units(raw.amount, info.decimals)
              : MaxUint256;
      if (
        !(await this.confirm(
          "approval",
          { to, token, mode, amount: amount.toString(), symbol: info.symbol },
          network,
          profiles.length,
        ))
      )
        return { cancelled: true };
      if (generation !== this.generation) throw Error("授权设置已改变");
      this.approvalActive = true;
      const run = {
          id: crypto.randomUUID(),
          network,
          reserveFee: 0n,
          reserveValue: 0n,
        },
        allowed = () => this.approvalActive && generation === this.generation;
      const work = mapLimit(profiles, 4, async (p) => {
        try {
          const w = { profile: p, pool: await this.poolFor(p) };
          await this.refreshWallet(w);
          if (w.unknown) throw Error("存在结果未知交易，先核对 nonce");
          const current = ERC20.decodeFunctionResult(
            "allowance",
            await w.pool.read("call", {
              to: token,
              data: ERC20.encodeFunctionData("allowance", [p.address, to]),
            }),
          )[0];
          for (const next of current !== 0n &&
          current !== amount &&
          amount !== 0n
            ? [0n, amount]
            : current === amount
              ? []
              : [amount]) {
            if (!allowed()) throw Error("授权已停止");
            const tx = {
              chainId: BigInt(network.chainId),
              nonce: w.nextNonce,
              to: token,
              value: 0n,
              data: ERC20.encodeFunctionData("approve", [to, next]),
              gasLimit: units(p.gasLimit, 0),
              ...this.fees(p).fields,
            };
            const r = await this.submit(run, w, tx, "approval", allowed);
            if (!r || r.status !== "pending")
              throw Error("授权发送结果未知，请核对记录");
            let receipt;
            const end = Date.now() + 120000;
            while (allowed() && Date.now() < end) {
              receipt = await w.pool.receipt(r.hash, r);
              if (receipt) break;
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
            if (!receipt || !receipt.status)
              throw Error("授权尚未确认或已回滚");
            validateReceipt(receipt, r.hash, r);
            const canonical = await w.pool.read(
              "getBlock",
              receipt.blockNumber,
            );
            if (
              !canonical ||
              canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase()
            )
              throw Error("授权回执不属于规范区块");
            if (!allowed()) throw Error("授权已停止");
            const actual = ERC20.decodeFunctionResult(
              "allowance",
              await w.pool.read("call", {
                to: token,
                data: ERC20.encodeFunctionData("allowance", [p.address, to]),
              }),
            )[0];
            if (actual !== next) throw Error("授权回执成功但实际额度不符");
            await this.refreshWallet(w);
          }
          return { address: p.address, success: true };
        } catch (e) {
          return { address: p.address, error: cleanError(e) };
        }
      });
      this.track(work);
      try {
        return { ...info, mode, results: await work };
      } finally {
        this.approvalActive = false;
        this.publish();
      }
    } finally {
      this.busy = false;
      this.publish();
    }
  }
  async stop(reason = "用户停止") {
    this.generation++;
    this.previews.clear();
    this.approvalActive = false;
    const run = this.run;
    if (run) {
      run.active = false;
      clearInterval(run.timer);
      run.monitor?.stop();
    }
    this.task.status = "stopped";
    this.task.reason = reason;
    await Promise.allSettled([...this.ops]);
    this.publish();
    return this.task;
  }
  async close() {
    clearTimeout(this.publishTimer);
    clearInterval(this.timer);
    await this.stop("程序退出");
    for (const p of this.pools.values()) p.destroy();
    this.pools.clear();
    clearTimeout(this.publishTimer);
    this.publishTimer = null;
    this.journal.close();
    this.vault.lock();
  }
}
module.exports = { Engine, ERC20, mapLimit };
