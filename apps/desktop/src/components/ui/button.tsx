import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib";
const variants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 min-h-10 px-4 py-2 [&_svg]:size-4",
  { variants: { variant: { default: "bg-primary text-primary-foreground hover:opacity-90", outline: "border border-border bg-background hover:bg-muted", ghost: "hover:bg-muted" } }, defaultVariants: { variant: "default" } },
);
export function Button({ className, variant, asChild = false, ...props }: React.ComponentProps<"button"> & VariantProps<typeof variants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : "button";
  return <Component className={cn(variants({ variant }), className)} {...props} />;
}
