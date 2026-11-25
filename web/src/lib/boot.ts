/** Fade out the boot screen from index.html. Safe to call more than once. */
export function hideBoot() {
  const el = document.getElementById("boot");
  if (!el || el.classList.contains("boot--done")) return;
  el.classList.add("boot--done");
  window.setTimeout(() => el.remove(), 700);
}
