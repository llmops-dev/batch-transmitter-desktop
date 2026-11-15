"use strict";
const http = require("node:http"),
  https = require("node:https"),
  zlib = require("node:zlib");
const MAX = 4 * 1024 * 1024;
// A node is untrusted input. Bound compressed and decoded responses independently.
function boundedGetUrl(req, signal) {
  return new Promise((resolve, reject) => {
    let response,
      done = false;
    const chunks = [];
    let size = 0;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) {
        response?.destroy();
        request.destroy();
        reject(error);
      } else resolve(value);
    };
    const request = (
      new URL(req.url).protocol === "https:" ? https : http
    ).request(req.url, { method: req.method, headers: req.headers }, (resp) => {
      response = resp;
      if (Number(resp.headers["content-length"]) > MAX)
        return finish(Error("RPC 响应超过 4 MiB"));
      resp.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX) return finish(Error("RPC 响应超过 4 MiB"));
        chunks.push(chunk);
      });
      resp.on("error", () => finish(Error("RPC 响应中断")));
      resp.on("aborted", () => finish(Error("RPC 响应中断")));
      resp.on("end", () => {
        try {
          let body = Buffer.concat(chunks, size);
          const headers = Object.fromEntries(
            Object.entries(resp.headers).map(([k, v]) => [
              k,
              Array.isArray(v) ? v.join(", ") : String(v ?? ""),
            ]),
          );
          if (headers["content-encoding"] === "gzip")
            body = zlib.gunzipSync(body, { maxOutputLength: MAX });
          else if (headers["content-encoding"] === "deflate")
            body = zlib.inflateSync(body, { maxOutputLength: MAX });
          else if (
            headers["content-encoding"] &&
            headers["content-encoding"] !== "identity"
          )
            throw Error("RPC 压缩格式不支持");
          finish(null, {
            statusCode: resp.statusCode || 0,
            statusMessage: resp.statusMessage || "",
            headers,
            body,
          });
        } catch {
          finish(Error("RPC 响应格式无效或解压后过大"));
        }
      });
    });
    const timer = setTimeout(
      () => finish(Error("RPC 请求超时")),
      Math.min(req.timeout || 10000, 10000),
    );
    request.on("error", () => finish(Error("RPC 网络请求失败")));
    if (signal) {
      signal.addListener(() => finish(Error("RPC 请求已取消")));
      if (signal.cancelled) return finish(Error("RPC 请求已取消"));
    }
    request.end(req.body ? Buffer.from(req.body) : undefined);
  });
}
module.exports = { boundedGetUrl, MAX };
