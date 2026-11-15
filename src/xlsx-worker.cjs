"use strict";
const {
  isMainThread,
  parentPort,
  workerData,
  Worker,
} = require("node:worker_threads");
if (!isMainThread) {
  require("./xlsx.cjs")
    .read(Buffer.from(workerData))
    .then(
      (rows) => parentPort.postMessage({ rows }),
      () =>
        parentPort.postMessage({
          error: "XLSX 格式无效、包含公式或超过安全限额",
        }),
    );
} else
  module.exports.read = (buffer) =>
    new Promise((resolve, reject) => {
      const w = new Worker(__filename, {
        workerData: buffer,
        resourceLimits: {
          maxOldGenerationSizeMb: 192,
          maxYoungGenerationSizeMb: 32,
        },
      });
      const timer = setTimeout(() => {
        w.terminate();
        reject(Error("XLSX 解析超时"));
      }, 15000);
      w.once("message", (m) => {
        clearTimeout(timer);
        w.terminate();
        m.error ? reject(Error(m.error)) : resolve(m.rows);
      });
      w.once("error", () => {
        clearTimeout(timer);
        reject(Error("XLSX 解析失败或资源限额超出"));
      });
      w.once("exit", (code) => {
        clearTimeout(timer);
        if (code) reject(Error("XLSX 解析已中止"));
      });
    });
