import { useId, useState } from 'react';
import { Popover } from 'radix-ui';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Button } from './button';
import { Input } from './input';
import { ScrollArea } from './scroll-area';

export function ProviderPicker({value,items,label,placeholder,searchLabel,empty,disabled,onChange}:{value:string;items:{id:string;name:string}[];label:string;placeholder:string;searchLabel:string;empty:string;disabled?:boolean;onChange:(value:string)=>void}) {
 const [open,setOpen]=useState(false);
 const [query,setQuery]=useState('');
 const [active,setActive]=useState(0);
 const id=useId();
 const filtered=items.filter(item=>`${item.name} ${item.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
 function select(value:string){onChange(value);setOpen(false);}
 return <Popover.Root open={open} onOpenChange={value=>{setOpen(value);setQuery('');setActive(0);}}>
  <Popover.Trigger asChild><Button variant="outline" role="combobox" aria-label={label} aria-expanded={open} aria-controls={id} disabled={disabled} className="w-full justify-between"><span className="truncate">{items.find(item=>item.id===value)?.name ?? placeholder}</span><ChevronsUpDown className="size-4 shrink-0"/></Button></Popover.Trigger>
  <Popover.Portal><Popover.Content align="start" sideOffset={4} className="z-50 w-[var(--radix-popover-trigger-width)] rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-md">
   <Input aria-label={searchLabel} placeholder={searchLabel} value={query} aria-controls={id} aria-activedescendant={filtered[active] ? `${id}-${active}` : undefined} onChange={event=>{setQuery(event.target.value);setActive(0);}} onKeyDown={event=>{
    if(event.key==='ArrowDown'){event.preventDefault();setActive(index=>Math.min(index+1,filtered.length-1));}
    if(event.key==='ArrowUp'){event.preventDefault();setActive(index=>Math.max(0,index-1));}
    if(event.key==='Enter' && filtered[active]){event.preventDefault();select(filtered[active].id);}
   }}/>
   <ScrollArea className="mt-2" style={{ height: Math.min(256, Math.max(64, filtered.length * 40)) }}><div id={id} role="listbox" aria-label={label}>{filtered.map((item,index)=><button key={item.id} id={`${id}-${index}`} type="button" role="option" aria-selected={value===item.id} onMouseEnter={()=>setActive(index)} onClick={()=>select(item.id)} className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm ${index===active ? 'bg-accent text-accent-foreground' : ''}`}>{item.name}{value===item.id && <Check className="size-4"/>}</button>)}{!filtered.length && <p className="p-3 text-sm text-muted-foreground">{empty}</p>}</div></ScrollArea>
  </Popover.Content></Popover.Portal>
 </Popover.Root>;
}
