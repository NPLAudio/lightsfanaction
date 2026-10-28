// Hardware sidecar for Lights Fan Action: exposes LibreHardwareMonitor sensors and fan controls
// over a loopback TCP socket (one JSON object per line). Every exit path hands the fans back to
// firmware control: client disconnect, "shutdown", parent exit, heartbeat timeout, Ctrl+C.
//
// Built for .NET Framework 4.7.2, which ships with Windows, so no runtime has to be installed.
// LibreHardwareMonitor itself is not included: it is installed separately and loaded from its own
// folder (see LhmLocator).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using LfaHw;
using LibreHardwareMonitor.Hardware;

string? token = null, portFile = null;
int parentPid = 0;
for (int i = 0; i < args.Length - 1; i++)
{
    switch (args[i])
    {
        case "--token": token = args[i + 1]; break;
        case "--port-file": portFile = args[i + 1]; break;
        case "--parent": parentPid = int.Parse(args[i + 1]); break;
        // "--lhm-dir" is read by LhmLocator before this program starts
    }
}
if (token is null || portFile is null)
{
    Console.Error.WriteLine("usage: lfa-hw --token T --port-file F [--parent PID] [--lhm-dir DIR]");
    return 2;
}

Hardware? hw = null;
string? startError = null;
try
{
    hw = new Hardware();
}
catch (Exception e) when (e is FileNotFoundException or FileLoadException or BadImageFormatException
    or TypeLoadException or MissingMethodException or TypeInitializationException)
{
    startError = LhmLocator.Describe(e);
}
AppDomain.CurrentDomain.ProcessExit += (_, _) => hw?.ResetAll();
Console.CancelKeyPress += (_, e) => { hw?.ResetAll(); e.Cancel = false; };

// If the app dies without saying goodbye, don't leave fans pinned at a software speed.
if (parentPid != 0)
{
    new Thread(() =>
    {
        try { Process.GetProcessById(parentPid).WaitForExit(); } catch { }
        hw?.ResetAll();
        Environment.Exit(0);
    }) { IsBackground = true }.Start();
}
new Thread(() =>
{
    while (true)
    {
        Thread.Sleep(1000);
        if (hw is not null && hw.StaleFor() > TimeSpan.FromSeconds(8)) hw.ResetAll();
    }
}) { IsBackground = true }.Start();

var listener = new TcpListener(IPAddress.Loopback, 0);
listener.Start();
var tmp = portFile + ".tmp";
File.WriteAllText(tmp, ((IPEndPoint)listener.LocalEndpoint).Port.ToString());
if (File.Exists(portFile)) File.Delete(portFile);
File.Move(tmp, portFile);

var json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
var utf8 = new UTF8Encoding(false);

if (hw is null)
{
    // tell the app why there is nothing to talk to, then stop
    using var failed = listener.AcceptTcpClient();
    var fs = failed.GetStream();
    new StreamReader(fs, utf8).ReadLine();
    var fw = new StreamWriter(fs, utf8) { AutoFlush = true, NewLine = "\n" };
    fw.WriteLine(json.Serialize(new { ok = false, error = startError }));
    return 3;
}

static double Number(object? o) => Convert.ToDouble(o, System.Globalization.CultureInfo.InvariantCulture);

bool quit = false;
while (!quit)
{
    using var client = listener.AcceptTcpClient();
    client.ReceiveTimeout = 0;
    var stream = client.GetStream();
    var reader = new StreamReader(stream, utf8);
    var writer = new StreamWriter(stream, utf8) { AutoFlush = true, NewLine = "\n" };
    try
    {
        var hello = reader.ReadLine();
        if (hello is null) continue;
        var helloMsg = json.Deserialize<Dictionary<string, object>>(hello);
        if (!helloMsg.TryGetValue("token", out var sent) || !string.Equals(sent as string, token, StringComparison.Ordinal)) continue;
        hw.Touch();
        writer.WriteLine(json.Serialize(new { ok = true, elevated = Hardware.IsAdmin }));
        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            hw.Touch();
            var msg = json.Deserialize<Dictionary<string, object>>(line);
            switch (msg["cmd"] as string)
            {
                case "apply":
                    if (msg.TryGetValue("release", out var rel) && rel is IEnumerable releases)
                        foreach (var r in releases) hw.Release((string)r);
                    if (msg.TryGetValue("set", out var sets) && sets is IEnumerable setList)
                        foreach (Dictionary<string, object> s in setList)
                            hw.SetFan((string)s["id"], Number(s["pct"]));
                    writer.WriteLine(json.Serialize(hw.Snapshot()));
                    break;
                case "reset":
                    hw.ResetAll();
                    writer.WriteLine("{\"ok\":true}");
                    break;
                case "shutdown":
                    hw.ResetAll();
                    writer.WriteLine("{\"ok\":true}");
                    quit = true;
                    break;
                default:
                    writer.WriteLine("{\"error\":\"unknown command\"}");
                    break;
            }
            if (quit) break;
        }
    }
    catch (Exception e) when (e is IOException or ArgumentException or InvalidOperationException
        or KeyNotFoundException or InvalidCastException or FormatException)
    {
        Console.Error.WriteLine(e.Message);
    }
    finally
    {
        hw.ResetAll(); // client gone: back to firmware control
    }
}
hw.Dispose();
return 0;

sealed class Hardware : IDisposable
{
    readonly Computer computer = new()
    {
        IsCpuEnabled = true,
        IsGpuEnabled = true,
        IsMotherboardEnabled = true,
        IsControllerEnabled = true,
        IsStorageEnabled = true,
    };
    readonly object gate = new();
    readonly HashSet<ISensor> overridden = new();
    Dictionary<string, ISensor> controls = new();
    long lastTouch = Stopwatch.GetTimestamp();
    long lastStorageUpdate;
    static readonly TimeSpan StorageEvery = TimeSpan.FromSeconds(30);

    public static bool IsAdmin =>
        new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);

    public Hardware() => computer.Open();
    public void Dispose() => computer.Close();

    static TimeSpan Since(long timestamp) =>
        TimeSpan.FromSeconds((Stopwatch.GetTimestamp() - timestamp) / (double)Stopwatch.Frequency);

    public void Touch() => Interlocked.Exchange(ref lastTouch, Stopwatch.GetTimestamp());
    public TimeSpan StaleFor() => Since(Interlocked.Read(ref lastTouch));

    static void UpdateAll(IHardware h)
    {
        h.Update();
        foreach (var s in h.SubHardware) UpdateAll(s);
    }
    static IEnumerable<ISensor> AllSensors(IHardware h) =>
        h.Sensors.Concat(h.SubHardware.SelectMany(AllSensors));

    static string Norm(string name) =>
        Regex.Replace(Regex.Replace(name, @"\bcontrol\b", "", RegexOptions.IgnoreCase), @"\s+", " ").Trim();

    public object Snapshot()
    {
        lock (gate)
        {
            foreach (var h in computer.Hardware)
            {
                // drive temperatures change slowly and every refresh is a SMART/NVMe query
                if (h.HardwareType == HardwareType.Storage && lastStorageUpdate != 0
                    && Since(lastStorageUpdate) < StorageEvery) continue;
                UpdateAll(h);
                if (h.HardwareType == HardwareType.Storage) lastStorageUpdate = Stopwatch.GetTimestamp();
            }
            var all = computer.Hardware.SelectMany(AllSensors).ToList();

            var temps = all
                .Where(s => s.SensorType == SensorType.Temperature && s.Value is not null)
                .Select(s => new
                {
                    id = s.Identifier.ToString(),
                    name = $"{s.Hardware.Name} · {s.Name}",
                    value = Math.Round(s.Value!.Value, 1),
                    unit = "°C",
                })
                .ToList();

            var rpm = all.Where(s => s.SensorType == SensorType.Fan)
                .GroupBy(s => s.Hardware.Identifier + "|" + Norm(s.Name))
                .ToDictionary(g => g.Key, g => g.First());
            controls = new Dictionary<string, ISensor>();
            var fans = new List<object>();
            foreach (var c in all.Where(s => s.SensorType == SensorType.Control && s.Control is not null))
            {
                var id = c.Identifier.ToString();
                controls[id] = c;
                rpm.TryGetValue(c.Hardware.Identifier + "|" + Norm(c.Name), out var r);
                fans.Add(new
                {
                    id,
                    name = $"{c.Hardware.Name} · {Norm(c.Name)}",
                    rpm = (int)Math.Round(r?.Value ?? 0),
                    pct = (int)Math.Round(c.Value ?? 0),
                });
            }
            return new { sensors = temps, fans };
        }
    }

    public void SetFan(string id, double pct)
    {
        lock (gate)
        {
            if (!controls.TryGetValue(id, out var s) || s.Control is null) return;
            // a stalled pump can cook a CPU in seconds, so it never goes below half speed
            var floor = Regex.IsMatch(s.Name + " " + s.Hardware.Name, "pump|aio|water|liquid", RegexOptions.IgnoreCase) ? 50 : 0;
            s.Control.SetSoftware((float)Math.Max(floor, Math.Min(100, pct)));
            overridden.Add(s);
        }
    }

    /// <summary>Hands one control back to the firmware.</summary>
    public void Release(string id)
    {
        lock (gate)
        {
            if (!controls.TryGetValue(id, out var s) || s.Control is null) return;
            try { s.Control.SetDefault(); } catch { /* ignore */ }
            overridden.Remove(s);
        }
    }

    public void ResetAll()
    {
        lock (gate)
        {
            foreach (var s in overridden)
            {
                try { s.Control?.SetDefault(); } catch { /* keep resetting the rest */ }
            }
            overridden.Clear();
        }
    }
}
