using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.AccessControl;
using System.Security.Principal;

// lets the C# compiler run LhmLocator.Init when the program loads, on runtimes that predate the attribute
namespace System.Runtime.CompilerServices
{
    [AttributeUsage(AttributeTargets.Method, Inherited = false)]
    internal sealed class ModuleInitializerAttribute : Attribute { }
}

namespace LfaHw
{
    /// <summary>
    /// LibreHardwareMonitor is not shipped with this program. It is installed separately by the user, and its
    /// assemblies are loaded from wherever it lives. The folder comes from `--lhm-dir`, the LFA_LHM_DIR
    /// environment variable, or a handful of standard places.
    ///
    /// This program runs with administrator rights, and loading a library runs its code. So when elevated it
    /// only loads from a folder that ordinary programs cannot change; otherwise anything running as the user
    /// could drop a library there and have it run as administrator.
    /// </summary>
    static class LhmLocator
    {
        public const string LibraryFile = "LibreHardwareMonitorLib.dll";

        public static string? Dir { get; private set; }

        /// <summary>A folder with LibreHardwareMonitor in it that was refused because ordinary programs can change it.</summary>
        public static string? Rejected { get; private set; }

        static string? RejectedWhy;

        public static bool Elevated =>
            new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);

        [ModuleInitializer]
        internal static void Init()
        {
            string? hint = null;
            var args = Environment.GetCommandLineArgs();
            for (int i = 0; i < args.Length - 1; i++)
                if (args[i] == "--lhm-dir") hint = args[i + 1];

            Dir = Find(hint);
            if (Dir is null) return;

            // only fires for assemblies the runtime cannot find itself, so framework assemblies keep
            // coming from Windows and only LibreHardwareMonitor's own libraries come from its folder
            AppDomain.CurrentDomain.AssemblyResolve += (_, e) =>
            {
                var path = Path.Combine(Dir, new AssemblyName(e.Name).Name + ".dll");
                return File.Exists(path) ? Assembly.LoadFrom(path) : null;
            };
        }

        static string? Find(string? hint)
        {
            var candidates = new List<string?>
            {
                hint,
                Environment.GetEnvironmentVariable("LFA_LHM_DIR"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "LibreHardwareMonitor"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "LibreHardwareMonitor"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "LibreHardwareMonitor"),
            };
            // winget unpacks the portable build into a per-package folder
            foreach (var root in new[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "WinGet", "Packages"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "WinGet", "Packages"),
            })
            {
                try
                {
                    if (Directory.Exists(root))
                        candidates.AddRange(Directory.GetDirectories(root, "LibreHardwareMonitor.LibreHardwareMonitor_*"));
                }
                catch (IOException) { /* unreadable: skip */ }
                catch (UnauthorizedAccessException) { }
            }

            var elevated = Elevated;
            foreach (var d in candidates)
            {
                if (string.IsNullOrWhiteSpace(d) || !File.Exists(Path.Combine(d!, LibraryFile))) continue;
                if (elevated && !OnlyAdminsCanChange(d!))
                {
                    if (Rejected is null) { Rejected = d; RejectedWhy = Why; }
                    continue;
                }
                return d;
            }
            return null;
        }

        static readonly SecurityIdentifier[] Trusted =
        {
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
            new SecurityIdentifier(WellKnownSidType.CreatorOwnerSid, null),
            new SecurityIdentifier("S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"), // TrustedInstaller
        };

        const FileSystemRights Replaces = FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles
            | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
        const FileSystemRights Plants = FileSystemRights.WriteData | FileSystemRights.AppendData | FileSystemRights.CreateFiles;

        /// <summary>
        /// True when only SYSTEM, administrators and the installer can add, replace or remove files in the
        /// folder, and nobody else can swap out any folder above it.
        /// </summary>
        static string Name(SecurityIdentifier? sid)
        {
            if (sid is null) return "an unknown account";
            try { return sid.Translate(typeof(NTAccount)).Value; }
            catch (Exception e) when (e is IdentityNotMappedException or SystemException) { return sid.Value; }
        }

        /// <summary>Why the last folder checked by <see cref="OnlyAdminsCanChange"/> was refused.</summary>
        public static string? Why { get; private set; }

        public static bool OnlyAdminsCanChange(string path)
        {
            try
            {
                var target = true;
                for (var d = new DirectoryInfo(Path.GetFullPath(path)); d is not null; d = d.Parent)
                {
                    var sec = d.GetAccessControl(AccessControlSections.Access | AccessControlSections.Owner);
                    var owner = sec.GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
                    if (owner is null || !Trusted.Contains(owner))
                    {
                        Why = $"{d.FullName} is owned by {Name(owner)}";
                        return false;
                    }

                    // the folder itself must also refuse new files; above it, being able to create siblings is normal
                    var bad = target ? Replaces | Plants : Replaces;
                    foreach (FileSystemAccessRule r in sec.GetAccessRules(true, true, typeof(SecurityIdentifier)))
                    {
                        if (r.AccessControlType != AccessControlType.Allow) continue;
                        // inherit-only rules apply to what is inside the folder, which is checked on its own
                        if ((r.PropagationFlags & PropagationFlags.InheritOnly) != 0) continue;
                        if (Trusted.Contains((SecurityIdentifier)r.IdentityReference)) continue;
                        if ((r.FileSystemRights & bad) != 0)
                        {
                            Why = $"{Name((SecurityIdentifier)r.IdentityReference)} can change {d.FullName}";
                            return false;
                        }
                    }
                    target = false;
                }
                return true;
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or SystemException)
            {
                return false; // cannot tell: treat as unsafe
            }
        }

        public static string Describe(Exception e) =>
            Dir is not null ? $"LibreHardwareMonitor in {Dir} could not be loaded: {e.Message}"
            : Rejected is not null ? $"LibreHardwareMonitor was found in {Rejected}, but regular programs can change it ({RejectedWhy ?? "permissions could not be read"}). Fan control runs with administrator rights, so only administrators may be able to change that folder. Re-run the installer and tick the admin-only option, or fix the folder's permissions."
            : "LibreHardwareMonitor was not found. Install it (see the project page) or set its folder in Settings.";
    }
}
