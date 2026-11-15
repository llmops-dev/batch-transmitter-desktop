"use strict";
// In-page anchors are UI state, not a different trusted document. No query,
// another file, frame or window is granted the IPC bridge by this check.
function isTrustedPage(actual, expected) {
  try {
    const url = new URL(actual), page = new URL(expected);
    if (url.protocol !== "file:" || page.protocol !== "file:" || url.search || page.search) return false;
    url.hash = ""; page.hash = "";
    return url.href === page.href;
  } catch { return false; }
}
module.exports = { isTrustedPage };
