/**
 * Shared UI primitives, matching the Stitch mockups' layout but rebuilt on the
 * design-system tokens and with the accessibility the mockups lacked: real
 * labels, described errors, and named icon controls.
 */

import type { ComponentChildren, JSX } from "preact";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

// `min-h-11` is 44px, the minimum comfortable touch target. It is on the base
// rather than the size utilities so a caller passing tighter padding — the
// guest "Remove" control does — cannot shrink the tap area below it.
const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-full font-body font-bold " +
  "min-h-11 cursor-pointer " +
  "transition-colors disabled:opacity-50 disabled:pointer-events-none active:scale-[0.98]";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  // Near-black on lime, the design system's high-impact pairing.
  primary: "bg-lime text-on-lime hover:bg-lime-dim",
  secondary: "bg-on-surface text-surface-lowest hover:bg-on-surface-variant",
  ghost:
    "bg-surface-container text-on-surface hover:bg-surface-high border border-outline-variant",
  danger: "bg-error text-on-error hover:opacity-90",
};

export function Button(
  props: JSX.IntrinsicElements["button"] & {
    variant?: ButtonVariant;
    fullWidth?: boolean;
  },
) {
  const { variant = "primary", fullWidth, class: cls, ...rest } = props;
  return (
    <button
      {...rest}
      class={cx(
        BUTTON_BASE,
        BUTTON_VARIANTS[variant],
        "px-6 py-3 text-[14px]",
        fullWidth && "w-full",
        cls as string,
      )}
    />
  );
}

export function LinkButton(
  props: JSX.IntrinsicElements["a"] & {
    variant?: ButtonVariant;
    fullWidth?: boolean;
  },
) {
  const { variant = "primary", fullWidth, class: cls, ...rest } = props;
  return (
    <a
      {...rest}
      class={cx(
        BUTTON_BASE,
        BUTTON_VARIANTS[variant],
        "px-6 py-3 text-[14px] no-underline",
        fullWidth && "w-full",
        cls as string,
      )}
    />
  );
}

export function Card(
  props: { children: ComponentChildren; class?: string; accent?: boolean },
) {
  return (
    <div
      class={cx(
        "bg-surface-lowest rounded-xl p-5 shadow-card",
        props.accent && "border-l-4 border-lime",
        props.class,
      )}
    >
      {props.children}
    </div>
  );
}

type ChipTone = "neutral" | "success" | "warning" | "error" | "info";

const CHIP_TONES: Record<ChipTone, string> = {
  neutral: "bg-surface-variant text-on-surface-variant",
  success: "bg-success/20 text-on-primary-container",
  warning: "bg-warning/20 text-on-surface",
  error: "bg-error-container text-on-error-container",
  info: "bg-tertiary-container text-on-tertiary-container",
};

export function Chip(
  props: { children: ComponentChildren; tone?: ChipTone; class?: string },
) {
  return (
    <span
      class={cx(
        "inline-flex items-center px-3 py-1 rounded-full text-label-sm font-medium",
        CHIP_TONES[props.tone ?? "neutral"],
        props.class,
      )}
    >
      {props.children}
    </span>
  );
}

/**
 * Text input with a real, associated label. The mockups used bare placeholders,
 * which vanish on focus and are not announced by screen readers.
 */
export function Field(
  props: {
    label: string;
    name: string;
    error?: string;
    hint?: string;
    children?: ComponentChildren;
  } & Omit<JSX.IntrinsicElements["input"], "name">,
) {
  const { label, name, error, hint, children, class: cls, ...rest } = props;
  const hintId = hint ? `${name}-hint` : undefined;
  const errorId = error ? `${name}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div class="flex flex-col gap-1.5">
      <label for={name} class="text-label font-bold text-on-surface-variant">
        {label}
      </label>
      {hint && (
        <p id={hintId} class="text-label-sm text-on-surface-variant">
          {hint}
        </p>
      )}
      {children ?? (
        <input
          {...rest}
          id={name}
          name={name}
          aria-describedby={describedBy}
          aria-invalid={error ? "true" : undefined}
          class={cx(
            "w-full rounded-lg bg-surface-lowest px-4 py-3 text-body-md text-on-surface",
            "border-2 transition-colors placeholder:text-on-surface-variant/60",
            error
              ? "border-error"
              : "border-outline-variant focus:border-primary",
            cls as string,
          )}
        />
      )}
      {error && (
        <p id={errorId} role="alert" class="text-label-sm text-error">
          {error}
        </p>
      )}
    </div>
  );
}

export function Select(
  props: {
    label: string;
    name: string;
    error?: string;
    hint?: string;
  } & Omit<JSX.IntrinsicElements["select"], "name">,
) {
  const { label, name, error, hint, class: cls, children, ...rest } = props;
  const hintId = hint ? `${name}-hint` : undefined;
  const errorId = error ? `${name}-error` : undefined;

  return (
    <div class="flex flex-col gap-1.5">
      <label for={name} class="text-label font-bold text-on-surface-variant">
        {label}
      </label>
      {hint && (
        <p id={hintId} class="text-label-sm text-on-surface-variant">{hint}</p>
      )}
      <select
        {...rest}
        id={name}
        name={name}
        aria-describedby={[hintId, errorId].filter(Boolean).join(" ") ||
          undefined}
        aria-invalid={error ? "true" : undefined}
        class={cx(
          "w-full rounded-lg bg-surface-lowest px-4 py-3 text-body-md text-on-surface",
          "border-2 transition-colors",
          error
            ? "border-error"
            : "border-outline-variant focus:border-primary",
          cls as string,
        )}
      >
        {children}
      </select>
    </div>
  );
}

export function Alert(
  props: {
    tone: "success" | "error" | "info";
    children: ComponentChildren;
    class?: string;
  },
) {
  const tones = {
    success: "bg-success/15 text-on-surface border-success/40",
    error: "bg-error-container text-on-error-container border-error/40",
    info: "bg-tertiary-container text-on-tertiary-container border-tertiary/30",
  };
  return (
    <div
      role={props.tone === "error" ? "alert" : "status"}
      class={cx(
        "rounded-lg border px-4 py-3 text-body-md",
        tones[props.tone],
        props.class,
      )}
    >
      {props.children}
    </div>
  );
}

/** Roster fill indicator, with the numbers exposed to assistive tech. */
export function ProgressBar(
  props: { value: number; max: number; label?: string },
) {
  const pct = props.max > 0
    ? Math.min(100, Math.round((props.value / props.max) * 100))
    : 0;
  // A full roster is the one state worth seeing without reading the numbers,
  // so it is the only one that changes colour. Anything short of full stays
  // neutral rather than shading gradually, which would turn "nearly full" into
  // a judgement the bar is not making.
  const full = props.max > 0 && props.value >= props.max;
  return (
    <div class="w-full">
      <div class="flex justify-between mb-1">
        <span class="text-label-sm text-on-surface-variant">
          {props.label ?? "Spots filled"}
        </span>
        <span class="text-label-sm font-bold text-on-surface">
          {props.value} / {props.max}
        </span>
      </div>
      <div
        class="w-full bg-surface-variant rounded-full h-2 overflow-hidden"
        role="progressbar"
        aria-valuenow={props.value}
        aria-valuemin={0}
        aria-valuemax={props.max}
        aria-label={props.label ?? "Spots filled"}
      >
        <div
          class={cx(
            "h-2 rounded-full transition-[background] duration-300",
            full
              ? "bg-gradient-to-r from-[#00e676] via-[#39ff14] to-[#00e676] shadow-[0_0_8px_rgba(57,255,20,0.55)]"
              : "bg-on-surface",
          )}
          style={`width:${pct}%`}
        />
      </div>
    </div>
  );
}

/** Falls back to an initial when a player has no photo. */
export function Avatar(
  props: { name: string; userId?: string; hasPhoto?: boolean; size?: number },
) {
  const size = props.size ?? 56;
  const initial = props.name.trim().charAt(0).toUpperCase() || "?";

  if (props.hasPhoto && props.userId) {
    return (
      <img
        src={`/api/photo/${props.userId}`}
        alt=""
        width={size}
        height={size}
        class="rounded-full object-cover border-2 border-surface shadow-card"
        style={`width:${size}px;height:${size}px`}
      />
    );
  }

  return (
    <div
      aria-hidden="true"
      class="rounded-full bg-surface-high flex items-center justify-center border-2 border-surface text-on-surface-variant font-bold"
      style={`width:${size}px;height:${size}px;font-size:${size / 2.6}px`}
    >
      {initial}
    </div>
  );
}

export function EmptyState(
  props: { title: string; children?: ComponentChildren },
) {
  return (
    <div class="text-center py-12 px-6">
      <p class="text-headline-md text-on-surface mb-2">{props.title}</p>
      {props.children && (
        <div class="text-body-md text-on-surface-variant">{props.children}</div>
      )}
    </div>
  );
}
