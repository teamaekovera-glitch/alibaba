import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: ButtonVariant;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: "bg-brand-600 text-white hover:bg-brand-700",
  secondary: "border border-brand-200 bg-white text-brand-700 hover:bg-brand-50",
};

/** Base button built on the PackSource design tokens (tokens.css). */
export function Button({ children, variant = "primary", type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      {...rest}
      className={`rounded-md px-4 py-2 text-sm font-medium ${variantClasses[variant]}`}
    >
      {children}
    </button>
  );
}

export { DemoDataBanner } from "./demo-banner";
export type { DemoDataBannerProps } from "./demo-banner";
