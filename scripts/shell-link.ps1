# Use the Unicode Shell Link interface, including IPersistFile for the filename.
# WScript.Shell can lose non-ANSI characters when saving links on Windows.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
namespace CodexUsage {
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
  class ShellLink {}
  [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, IntPtr findData, uint flags);
    void GetIDList(out IntPtr idList);
    void SetIDList(IntPtr idList);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder description, int count);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string description);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder directory, int count);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder arguments, int count);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
    void GetHotkey(out short hotkey);
    void SetHotkey(short hotkey);
    void GetShowCmd(out int command);
    void SetShowCmd(int command);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, out int index);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
    void Resolve(IntPtr window, uint flags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
  }
  public static class StartupLink {
    public static string ReadArguments(string filename) {
      object link = new ShellLink();
      try {
        ((IPersistFile)link).Load(filename, 0);
        var arguments = new StringBuilder(32768);
        ((IShellLinkW)link).GetArguments(arguments, arguments.Capacity);
        return arguments.ToString();
      } finally { Marshal.FinalReleaseComObject(link); }
    }
    public static void Save(string filename, string target, string arguments, string directory) {
      object link = new ShellLink();
      try {
        var shell = (IShellLinkW)link;
        shell.SetPath(target);
        shell.SetArguments(arguments);
        shell.SetWorkingDirectory(directory);
        shell.SetShowCmd(7);
        shell.SetDescription("Codex Usage managed startup");
        ((IPersistFile)link).Save(filename, true);
      } finally { Marshal.FinalReleaseComObject(link); }
    }
  }
}
'@
