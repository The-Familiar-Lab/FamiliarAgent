/** UI status reads must not hold unrelated hosts or recovery controls indefinitely. */
export const UI_READ_TIMEOUT_MS = 12000;
export async function readWithDeadline<T>(read: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out. Retry the check or choose another server.`)),
          UI_READ_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
