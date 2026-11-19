export function isGitHubReleaseBase(url) {
 return url.protocol==='https:' && url.hostname==='github.com' && !url.port && !url.username && !url.password && !url.search && !url.hash && /^\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/$/.test(url.pathname);
}

export function recipeFileUrl(base, path) {
 // Release assets have flat names; local recipe paths remain signed and unchanged.
 return new URL(isGitHubReleaseBase(base) ? path.replaceAll('/', '__') : path, base);
}

export async function fetchUpdateFile(url, {signal, fetchImpl=fetch}={}) {
 const initial=new URL(url);
 const base=new URL('.',initial);
 const github=isGitHubReleaseBase(base);
 let current=initial;
 for(let hop=0;hop<3;hop++) {
  const response=await fetchImpl(current,{signal,redirect:'manual',credentials:'omit',referrerPolicy:'no-referrer'});
  if(![301,302,303,307,308].includes(response.status))return response;
  const location=response.headers.get('location');
  await response.body?.cancel();
  if(!github || !location || hop===2)throw new Error('Update redirect rejected');
  const next=new URL(location,current);
  if(next.protocol!=='https:' || next.hostname!=='release-assets.githubusercontent.com' || next.port || next.username || next.password || next.hash)throw new Error('Update redirect rejected');
  current=next;
 }
 throw new Error('Update redirect limit exceeded');
}
