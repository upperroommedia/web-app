export const bounded = (promise, ms = 15000) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Owned media adoption deadline')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

export async function groupAbsent(owned) {
  const end = Date.now() + 2000;
  while (Date.now() < end) {
    try {
      process.kill(-owned.child.pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Owned media descendant remained');
}

/** Only for a detached child returned directly by this fixture's fork/spawn. */
export async function stopOwnedGroup(owned) {
  // A dead leader can leave a live FFmpeg descendant in its still-owned group.
  try {
    process.kill(-owned.child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  await bounded(owned.exited, 10000);
  await groupAbsent(owned);
}
