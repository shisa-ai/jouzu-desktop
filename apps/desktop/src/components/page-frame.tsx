import type { ReactNode } from 'react';

/** Shared page frame keeps navigation and scrolling independent of page content. */
export function PageFrame({title,description,action,children}:{title:string;description:string;action?:ReactNode;children:ReactNode}) {
 return <section className="flex min-h-0 flex-1 flex-col gap-4 py-4" aria-label={title}>
  <div data-slot="page-heading" className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] grid-rows-[2rem_1.25rem] items-start gap-x-4 gap-y-1">
   <h2 className="text-xl font-semibold">{title}</h2>
   <div className="row-span-2 flex min-h-9 items-start justify-end">{action}</div>
   <p title={description} className="min-w-0 truncate text-sm leading-5 text-muted-foreground">{description}</p>
  </div>
  <div data-slot="page-body" className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">{children}</div>
 </section>;
}
