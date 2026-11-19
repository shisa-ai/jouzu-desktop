import { cn } from "../../lib";

/** The app's dotted sign, animated: the same cyan-into-purple palette as the window icon, so a wait looks like Jouzu rather than a generic ring. */
export function JouzuLoader({ className, ...props }: React.ComponentProps<"span">) {
  return <span aria-hidden="true" className={cn("jouzu-loader", className)} {...props}><span /><span /><span /><span /></span>;
}
