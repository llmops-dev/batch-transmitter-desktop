"use strict";
const ExcelJS = require("exceljs"),
  yauzl = require("yauzl");
const columns = [
  "rpc",
  "privatekey",
  "gasPrice",
  "gasLimit",
  "eip1559",
  "maxFee",
  "maxPriorityFee",
];
async function validateZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > 5 * 1024 * 1024)
    throw Error("XLSX 文件超过 5 MiB");
  await new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, validateEntrySizes: true },
      (err, zip) => {
        if (err) return reject(Error("XLSX ZIP 文件无效"));
        let count = 0,
          total = 0,
          settled = false;
        const fail = (e) => {
          if (settled) return;
          settled = true;
          zip.close();
          reject(Error(e.message || "XLSX 解压失败"));
        };
        zip.on("error", fail);
        zip.on("end", () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        });
        zip.on("entry", (entry) => {
          if (
            ++count > 1000 ||
            entry.generalPurposeBitFlag & 1 ||
            /\.bin$/i.test(entry.fileName) ||
            entry.uncompressedSize > 20 * 1024 * 1024
          )
            return fail(Error("XLSX 含加密、宏或过大条目"));
          if (/\/$/.test(entry.fileName)) {
            zip.readEntry();
            return;
          }
          zip.openReadStream(entry, (e, stream) => {
            if (e) return fail(e);
            stream.on("error", fail);
            stream.on("data", (chunk) => {
              total += chunk.length;
              if (total > 20 * 1024 * 1024) {
                stream.destroy();
                fail(Error("XLSX 解压体积超过 20 MiB"));
              }
            });
            stream.on("end", () => {
              if (!settled) zip.readEntry();
            });
          });
        });
        zip.readEntry();
      },
    );
  });
}
function cell(value) {
  if (value == null) return "";
  if (typeof value === "object") throw Error("不接受公式、超链接或富文本字段");
  if (
    !["string", "number", "boolean"].includes(typeof value) ||
    String(value).length > 4096
  )
    throw Error("字段内容无效或过长");
  return value;
}
async function read(buffer) {
  await validateZip(buffer);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  const sheet = book.getWorksheet("accounts");
  if (!sheet || sheet.rowCount > 501)
    throw Error("需要 accounts 工作表，最多 500 个钱包");
  const header = sheet.getRow(1);
  const mapping = columns.map((k) => {
    for (let n = 1; n <= header.cellCount; n++)
      if (cell(header.getCell(n).value) === k) return n;
    throw Error("缺少字段 " + k);
  });
  const rows = [];
  for (let i = 2; i <= sheet.rowCount; i++) {
    const row = sheet.getRow(i),
      r = { row: i };
    for (let n = 0; n < columns.length; n++)
      r[columns[n]] = cell(row.getCell(mapping[n]).value);
    if (
      Object.values(r)
        .slice(1)
        .every((v) => v === "")
    )
      continue;
    rows.push(r);
  }
  return rows;
}
async function write(rows) {
  const book = new ExcelJS.Workbook();
  book.creator = "Batch Transmitter Desktop";
  const sheet = book.addWorksheet("accounts");
  sheet.columns = columns.map((key) => ({
    header: key,
    key,
    width: key === "privatekey" ? 70 : key === "rpc" ? 55 : 20,
  }));
  for (const r of rows)
    sheet.addRow(Object.fromEntries(columns.map((k) => [k, cell(r[k] ?? "")])));
  return Buffer.from(await book.xlsx.writeBuffer());
}
module.exports = { read, write, validateZip, columns };
