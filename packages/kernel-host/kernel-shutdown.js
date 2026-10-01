// Graceful workspace close, in the only order that proves it: admission closes
// and every PID is finalized with its receipts joined (fetch egress, in-flight
// SQLite persistence), THEN the mirror is flushed, THEN storage ownership is
// released so a reopening kernel can take the lock. Never throws: the returned
// strings are the cleanup errors the acknowledgement carries to the host.
export async function shutdownKernel({ kernel, persistence }) {
  const errors = [];
  const note = (error) => errors.push(String(error?.message || error));
  try {
    if (kernel) errors.push(...await kernel.shutdown());
  } catch (error) { note(error); }
  if (persistence) {
    try { await persistence.flush(); } catch (error) { note(error); }
    try { persistence.releaseOwnership(); } catch (error) { note(error); }
  }
  return errors;
}
