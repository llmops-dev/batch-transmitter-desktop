const test = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");
const XLSX = require("../src/xlsx.cjs");

test("accounts spreadsheet round-trips a synthetic wallet row", async () => {
  const row = {
    rpc: "http://127.0.0.1:1", privatekey: "synthetic-test-input", gasPrice: "2", gasLimit: "21000",
    eip1559: true, maxFee: "3", maxPriorityFee: "0.1"
  };
  const bytes = await XLSX.write([row]);
  assert.deepEqual(await XLSX.read(bytes), [{ row: 2, ...row }]);
});

test("invalid archives and spreadsheet formula cells are rejected", async () => {
  await assert.rejects(XLSX.read(Buffer.from("not an xlsx")), /ZIP 文件无效/);
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("accounts");
  sheet.addRow(XLSX.columns);
  sheet.addRow([{ formula: "1+1", result: 2 }]);
  const bytes = Buffer.from(await book.xlsx.writeBuffer());
  await assert.rejects(XLSX.read(bytes), /不接受公式/);
});
