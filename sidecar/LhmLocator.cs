using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;

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
    /// </summary>
    static class LhmLocator
    {
        public const string LibraryFile = "LibreHardwareMonitorLib.dll";

        public static string? Dir { get; private set; }

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
            return candidates.FirstOrDefault(d => !string.IsNullOrWhiteSpace(d) && File.Exists(Path.Combine(d, LibraryFile)));
        }

        public static string Describe(Exception e) => Dir is null
            ? "LibreHardwareMonitor was not found. Install it (see the project page) or set its folder in Settings."
            : $"LibreHardwareMonitor in {Dir} could not be loaded: {e.Message}";
    }
}
