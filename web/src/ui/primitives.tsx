import type { ButtonHTMLAttributes, ReactNode } from "react";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export function IconButton({
  active,
  label,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cx(
        "grid size-10 place-items-center rounded-lg transition-colors",
        active ? "bg-accent text-accent-fg" : "text-fg hover:bg-hover",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("rounded-xl border border-line bg-panel shadow-panel backdrop-blur-md", className)}>{children}</div>;
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  swatch,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  swatch?: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-hover">
      {swatch && <span className="size-2.5 shrink-0 rounded-full" style={{ background: swatch }} />}
      <span className="flex-1 text-[13px]">{label}</span>
      {hint && <span className="mono text-[11px] text-muted">{hint}</span>}
      <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="relative h-[18px] w-8 shrink-0 rounded-full bg-raised ring-1 ring-line transition-colors peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-accent after:absolute after:top-[3px] after:left-[3px] after:size-3 after:rounded-full after:bg-muted after:transition-transform peer-checked:after:translate-x-[14px] peer-checked:after:bg-accent-fg" />
    </label>
  );
}

export function Chip({
  on,
  onClick,
  color,
  children,
  count,
}: {
  on: boolean;
  onClick: () => void;
  color?: string;
  children: ReactNode;
  count?: number;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors",
        on ? "border-transparent bg-raised text-fg" : "border-line text-muted hover:text-fg",
      )}
      style={on && color ? { boxShadow: `inset 0 0 0 1px ${color}80`, background: `${color}22` } : undefined}
    >
      {color && <span className="size-2 rounded-full" style={{ background: color, opacity: on ? 1 : 0.4 }} />}
      {children}
      {count !== undefined && <span className="mono text-[10.5px] text-muted">{count}</span>}
    </button>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-1.5 mt-4 flex items-center justify-between px-2 first:mt-1">
      <h3 className="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{children}</h3>
      {action}
    </div>
  );
}

export function TextButton({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={cx("text-[11.5px] font-medium text-muted hover:text-accent", className)} {...rest} />;
}
