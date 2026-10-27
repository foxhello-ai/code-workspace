param([Parameter(Mandatory = $true)][string]$Installer)
$ErrorActionPreference = 'Stop'

# Hosted runners can have privileges that hide ordinary-user installation bugs.
# Remove these privileges from this disposable child process, never the runner.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class InstallerAclPrivileges
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Luid { public uint LowPart; public int HighPart; }
    [StructLayout(LayoutKind.Sequential)]
    private struct LuidAndAttributes { public Luid Luid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct TokenPrivileges { public uint Count; public LuidAndAttributes Privilege; }

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool LookupPrivilegeValue(string system, string name, out Luid luid);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TokenPrivileges state,
        uint length, IntPtr previousState, IntPtr returnLength);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr token, int informationClass,
        IntPtr information, int length, out int returnLength);

    public static void RemoveAndVerify()
    {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), 0x28, out token))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            string[] names = { "SeSecurityPrivilege", "SeBackupPrivilege", "SeRestorePrivilege", "SeTakeOwnershipPrivilege" };
            foreach (string name in names)
            {
                Luid luid;
                if (!LookupPrivilegeValue(null, name, out luid))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                TokenPrivileges state = new TokenPrivileges {
                    Count = 1, Privilege = new LuidAndAttributes { Luid = luid, Attributes = 4 }
                };
                if (!AdjustTokenPrivileges(token, false, ref state, 0, IntPtr.Zero, IntPtr.Zero))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                int error = Marshal.GetLastWin32Error();
                // ERROR_NOT_ALL_ASSIGNED means it was already absent.
                if (error != 0 && error != 1300) throw new Win32Exception(error);

                int length;
                GetTokenInformation(token, 3, IntPtr.Zero, 0, out length);
                if (length <= 0) throw new Win32Exception(Marshal.GetLastWin32Error());
                IntPtr buffer = Marshal.AllocHGlobal(length);
                try
                {
                    if (!GetTokenInformation(token, 3, buffer, length, out length))
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    int count = Marshal.ReadInt32(buffer);
                    int offset = (int)Marshal.OffsetOf(typeof(TokenPrivileges), "Privilege");
                    int size = Marshal.SizeOf(typeof(LuidAndAttributes));
                    for (int i = 0; i < count; i++)
                    {
                        var entry = (LuidAndAttributes)Marshal.PtrToStructure(
                            IntPtr.Add(buffer, offset + i * size), typeof(LuidAndAttributes));
                        if (entry.Luid.LowPart == luid.LowPart && entry.Luid.HighPart == luid.HighPart)
                            throw new InvalidOperationException(name + " is still present in the installer token.");
                    }
                }
                finally { Marshal.FreeHGlobal(buffer); }
            }
        }
        finally { CloseHandle(token); }
    }
}
'@
[InstallerAclPrivileges]::RemoveAndVerify()
Write-Output 'Verified: installer token has no security, backup, restore, or take-ownership privileges.'
& $Installer
