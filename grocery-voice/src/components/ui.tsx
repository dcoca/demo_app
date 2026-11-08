import type { ButtonHTMLAttributes, ComponentProps, ReactNode, SelectHTMLAttributes } from "react";

export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-600/50",
  secondary: "surface hover:brightness-95 dark:hover:brightness-125",
  ghost: "hover:bg-black/5 dark:hover:bg-white/10",
  danger: "bg-red-600 text-white hover:bg-red-700 disabled:bg-red-600/50",
};

export function Button({
  variant = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={cx(
        "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium transition disabled:cursor-not-allowed",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cx(
        "surface min-h-11 w-full rounded-xl px-3 text-base placeholder:text-[var(--muted)] sm:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx("surface min-h-11 w-full rounded-xl px-3 text-base sm:text-sm", className)} {...props} />;
}

export function Field({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {hint ? <p className="text-muted text-xs">{hint}</p> : null}
    </div>
  );
}

export function Card({ title, description, children, className }: { title?: string; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("surface rounded-2xl p-4 sm:p-5", className)}>
      {title ? <h2 className="text-base font-semibold">{title}</h2> : null}
      {description ? <div className="text-muted mt-1 text-sm">{description}</div> : null}
      <div className={title || description ? "mt-4" : undefined}>{children}</div>
    </section>
  );
}

const BADGE: Record<string, string> = {
  neutral: "bg-black/5 dark:bg-white/10",
  green: "bg-brand-100 text-brand-700 dark:bg-brand-700/30 dark:text-brand-100",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200",
  red: "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200",
  blue: "bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200",
};

export function Badge({ tone = "neutral", children }: { tone?: keyof typeof BADGE; children: ReactNode }) {
  return <span className={cx("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", BADGE[tone])}>{children}</span>;
}

export function Notice({ tone = "neutral", children }: { tone?: "neutral" | "amber" | "red" | "green"; children: ReactNode }) {
  const tones = {
    neutral: "surface",
    amber: "border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100",
    red: "border border-red-300 bg-red-50 text-red-900 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-100",
    green: "border border-brand-100 bg-brand-50 text-brand-700 dark:border-brand-700/50 dark:bg-brand-700/20 dark:text-brand-100",
  };
  return (
    <div role="status" className={cx("rounded-xl px-3 py-2 text-sm", tones[tone])}>
      {children}
    </div>
  );
}
