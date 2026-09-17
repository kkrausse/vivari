// Vivari processes are never Node single-executable applications.
export function createSea() {
  function unavailable() {
    const error = new Error("Operation cannot be invoked when not in a single-executable application");
    error.code = "ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION";
    throw error;
  }
  return {
    isSea: () => false,
    getAsset: unavailable,
    getAssetAsBlob: unavailable,
    getRawAsset: unavailable,
    getAssetKeys: unavailable,
  };
}
