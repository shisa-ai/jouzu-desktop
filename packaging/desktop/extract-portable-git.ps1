function Invoke-PortableGitExtraction([string]$Archive, [string]$Destination) {
 # A private desktop keeps the vendor SFX progress dialog off the user's desktop.
 # The unmodified SFX still runs its required post-install initialization.
 Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class JouzuPortableGit {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 struct STARTUPINFO {
  public int cb; public string reserved, desktop, title;
  public int x,y,cx,cy,charsX,charsY,fill,flags;
  public short show,reservedSize; public IntPtr reservedPtr,input,output,error;
 }
 [StructLayout(LayoutKind.Sequential)]
 struct PROCESS_INFORMATION { public IntPtr process,thread; public uint pid,tid; }
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 static extern IntPtr CreateDesktop(string name,IntPtr device,IntPtr mode,int flags,uint access,IntPtr security);
 [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 static extern bool CreateProcess(string app,StringBuilder command,IntPtr ps,IntPtr ts,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFO startup,out PROCESS_INFORMATION process);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 public static uint Extract(string archive,string destination) {
  string name="JouzuGit-"+Guid.NewGuid().ToString("N");
  IntPtr desktop=CreateDesktop(name,IntPtr.Zero,IntPtr.Zero,0,0x01FF,IntPtr.Zero);
  if(desktop==IntPtr.Zero) throw new Win32Exception();
  PROCESS_INFORMATION process=new PROCESS_INFORMATION();
  try {
   STARTUPINFO startup=new STARTUPINFO();startup.cb=Marshal.SizeOf(startup);startup.desktop=name;
   var command=new StringBuilder("\""+archive+"\" -y -o\""+destination+"\"");
   if(!CreateProcess(archive,command,IntPtr.Zero,IntPtr.Zero,false,0,IntPtr.Zero,null,ref startup,out process)) throw new Win32Exception();
   if(WaitForSingleObject(process.process,180000)!=0) {
    var kill=new System.Diagnostics.ProcessStartInfo(System.IO.Path.Combine(Environment.GetEnvironmentVariable("SystemRoot"),"System32","taskkill.exe"),"/PID "+process.pid+" /T /F");
    kill.UseShellExecute=false;kill.CreateNoWindow=true;
    using(var child=System.Diagnostics.Process.Start(kill)){child.WaitForExit(10000);}
    throw new TimeoutException("PortableGit preparation timed out");
   }
   uint code;if(!GetExitCodeProcess(process.process,out code)) throw new Win32Exception();
   return code;
  } finally {
   if(process.thread!=IntPtr.Zero) CloseHandle(process.thread);
   if(process.process!=IntPtr.Zero) CloseHandle(process.process);
   CloseDesktop(desktop);
  }
 }
}
'@
 return [JouzuPortableGit]::Extract($Archive,$Destination)
}
