const assert = require("node:assert/strict");
const sea = require("node:sea");
assert.equal(sea.isSea(), false);
for (const method of ["getAsset", "getRawAsset", "getAssetAsBlob", "getAssetKeys"]) {
  assert.throws(() => sea[method]("missing"), { code: "ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION" });
}
assert.equal(require("node:module").isBuiltin("node:sea"), true);
console.log("SEA_NON_EXECUTABLE_PASS");
