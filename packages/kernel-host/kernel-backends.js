// Complete kernel boot while honoring the VFS mirror's durable ownership lock.
// Cache storage shares that ownership domain; no lock means no durable cache.
export async function initializeKernelBackends(persistence, {
  openDepCache, openSqlite, onDepCacheError = () => {},
}) {
  let depCache = null;
  if (persistence) {
    try { depCache = await openDepCache(); }
    catch (error) { onDepCacheError(error); }
  }
  try {
    const sqlite = await openSqlite();
    return { depCache, sqlite };
  } catch (error) {
    // No ready kernel will own this lock if its required SQLite backend fails.
    persistence?.releaseOwnership();
    throw error;
  }
}
